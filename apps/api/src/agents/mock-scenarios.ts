import type { AgentInput } from './types.js';

export type MockLanguage = 'en' | 'zh-CN';
export type MockScenarioName = 'ordinary' | 'slow' | 'error' | 'code' | 'markdown' | 'remember' | 'context';
export interface MockScenario {
  name: MockScenarioName;
  language: MockLanguage;
  text: string;
  chunkSize: number;
  intervalMs: number;
  failureCode: 'UPSTREAM_ERROR' | null;
}

type History = ReadonlyArray<AgentInput['history'][number]>;
const memoryLimit = 80;
const commandPattern = /^\/(slow|error|code|markdown|remember|context)(?:[\t ]+([^\r\n\u0085\u2028\u2029]*))?$/u;

/** Explicit, bounded text fixtures. Arguments select prompt language but never change code or Markdown payloads. */
export const MOCK_SCENARIOS = [
  { command: '/slow', description: 'A cumulative text stream lasting approximately five seconds.' },
  { command: '/error', description: 'A persisted partial response followed by UPSTREAM_ERROR.' },
  { command: '/code', description: 'A fixed TypeScript block with copyable original bytes.' },
  { command: '/markdown', description: 'Fixed Markdown with unsafe HTML/URL fixtures and a legitimate link.' },
  { command: '/remember <value>', description: 'Acknowledge a single-line value of at most 80 Unicode characters without echoing it.' },
  { command: '/context', description: 'Return only the latest valid prior user /remember value, or a localized absence message.' },
] as const;

export const MOCK_CODE = "console.log('Hello from NexRun');\n";
export const MOCK_MARKDOWN = '**Readable text**\n\n<script>window.__nexrunXss = 1</script>\n\n<img src="x" onerror="window.__nexrunXss = 2">\n\n[unsafe](javascript:window.__nexrunXss=3)\n\n[reference](https://example.com)';

// Commands are recognized after outer whitespace is trimmed; internal newlines are not commands.
function command(prompt: string): { name: Exclude<MockScenarioName, 'ordinary'>; argument: string } | null {
  const match = commandPattern.exec(prompt.trim());
  return match ? { name: match[1] as Exclude<MockScenarioName, 'ordinary'>, argument: (match[2] ?? '').trim() } : null;
}

function validMemory(value: string): boolean {
  return value.length > 0 && Array.from(value).length <= memoryLimit && !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(value);
}

function rememberedValue(history: History): string | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.role !== 'user') continue;
    const parsed = command(message.content);
    if (parsed?.name === 'remember' && validMemory(parsed.argument)) return parsed.argument;
  }
  return undefined;
}

function requestedLanguage(prompt: string): MockLanguage {
  const requests: Array<{ pattern: RegExp; language: MockLanguage }> = [
    { pattern: /\b(?:reply|respond|answer|write|explain)(?:\s+(?:briefly|concisely))?\s+in\s+(?:English|en)\b/giu, language: 'en' },
    { pattern: /(?:用|以|使用)\s*(?:英文|英语|English)/giu, language: 'en' },
    { pattern: /\b(?:reply|respond|answer|write|explain)(?:\s+(?:briefly|concisely))?\s+in\s+(?:Simplified\s+Chinese|Chinese|zh-CN)\b/giu, language: 'zh-CN' },
    { pattern: /(?:用|以|使用)\s*(?:简体中文|中文|汉语)/gu, language: 'zh-CN' },
  ];
  let selected: { index: number; language: MockLanguage } | undefined;
  for (const request of requests) {
    for (const match of prompt.matchAll(request.pattern)) {
      if (!selected || match.index > selected.index) selected = { index: match.index, language: request.language };
    }
  }
  return selected?.language ?? (/\p{Script=Han}/u.test(prompt) ? 'zh-CN' : 'en');
}

function ordinaryReply(prompt: string, language: MockLanguage): string {
  if (/^(?:hello|hi|hey|你好|您好|嗨)(?:[\s,!！，.。?？]|$)/iu.test(prompt.trim())) {
    return language === 'zh-CN' ? '你好！今天想一起聊些什么？' : 'Hi! What would you like to work on today?';
  }
  if (/(?:write|draft|rewrite|写作|写一|文案|初稿)/iu.test(prompt)) {
    return language === 'zh-CN'
      ? '先写清最重要的一点，再用一个具体例子支撑，最后给出明确的下一步。'
      : 'Lead with the main point, support it with one concrete example, and close with a clear next action.';
  }
  if (/(?:explain|understand|clarify|解释|理解|说明)/iu.test(prompt)) {
    return language === 'zh-CN'
      ? '把问题拆成几个部分，说明它们之间的联系，再用一个具体例子检查理解。'
      : 'Break the topic into a few parts, explain how they connect, and use one concrete example to check understanding.';
  }
  if (/(?:compare|choose|decide|比较|选择|决定)/iu.test(prompt)) {
    return language === 'zh-CN'
      ? '先确定最重要的限制，再比较选项。选择一个容易调整的小步骤，并根据结果复盘。'
      : 'Compare the options against your main constraint, choose a small reversible step, and review the result.';
  }
  if (/(?:code|debug|test|代码|调试|测试)/iu.test(prompt)) {
    return language === 'zh-CN'
      ? '先明确预期行为，缩小改动范围，再用一个有针对性的检查验证结果。'
      : 'Keep the change small, name the expected behavior, and verify it with one focused check.';
  }
  return language === 'zh-CN'
    ? '先明确你希望得到的结果，再选一个可以立即完成的小步骤。完成后检查效果，再决定下一步。'
    : 'Start with the outcome you want. Choose one small next step, then check whether it moves you closer.';
}

/**
 * Build deterministic presentation data without performing I/O or retaining cross-conversation state.
 * The last recognized explicit response-language request wins; otherwise Han characters select zh-CN.
 * Both rules use only the current prompt, independently of UI locale and history.
 * Only explicit /context reads history, and only prior user /remember commands can supply its bounded value.
 */
export function buildMockScenario(prompt: string, history: History = []): MockScenario {
  const language = requestedLanguage(prompt);
  const parsed = command(prompt);
  const name = parsed?.name ?? 'ordinary';
  let text: string;
  let failureCode: MockScenario['failureCode'] = null;
  switch (name) {
    case 'slow':
      text = language === 'zh-CN'
        ? `这是一条用于验证流式传输和停止操作的慢速模拟回复。${'回复会逐步出现，你可以随时停止生成，已生成的内容将会保留。'.repeat(10)}`
        : `This is a deliberately slow mock response. ${'Streaming remains active until completed or stopped. '.repeat(10)}`;
      break;
    case 'error':
      text = language === 'zh-CN' ? '模拟错误发生前已生成的部分回复。' : 'Partial mock response before the simulated error.';
      failureCode = 'UPSTREAM_ERROR';
      break;
    case 'code':
      text = `${language === 'zh-CN' ? '这是一个简短的 TypeScript 示例。' : 'Here is a small TypeScript example.'}\n\n\`\`\`typescript\n${MOCK_CODE}\`\`\``;
      break;
    case 'markdown':
      text = MOCK_MARKDOWN;
      break;
    case 'remember':
      text = validMemory(parsed!.argument)
        ? language === 'zh-CN' ? '已记住这段对话中的值。' : 'Value remembered for this conversation.'
        : language === 'zh-CN' ? '请使用 /remember <value> 提供一个不超过 80 个字符的单行值。' : 'Use /remember <value> with one single-line value of at most 80 characters.';
      break;
    case 'context':
      text = rememberedValue(history) ?? (language === 'zh-CN' ? '这段对话中还没有记住任何值。' : 'No value has been remembered in this conversation.');
      break;
    default:
      text = ordinaryReply(prompt, language);
  }
  const chunkSize = name === 'slow' ? 5 : 12;
  const chunks = Math.ceil(Array.from(text).length / chunkSize);
  return { name, language, text, chunkSize, intervalMs: name === 'slow' ? Math.max(1, Math.round(5000 / chunks)) : 12, failureCode };
}
