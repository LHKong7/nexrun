import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createMockAdapter } from '../src/agents/mock.js';
import { buildMockScenario, MOCK_CODE, MOCK_MARKDOWN, MOCK_SCENARIOS } from '../src/agents/mock-scenarios.js';
import type { AgentInput } from '../src/agents/types.js';

type History = AgentInput['history'];
function input(prompt: string, history: History = [], controller = new AbortController(), conversationId = 'conversation-one'): AgentInput {
  return { prompt, history, conversationId, runId: 'run-one', signal: controller.signal };
}
function assertCumulative(outputs: string[], final: string) {
  assert.ok(outputs.length > 0);
  assert.equal(outputs.at(-1), final);
  for (let index = 0; index < outputs.length; index++) {
    assert.ok(final.startsWith(outputs[index]!));
    if (index > 0) assert.ok(outputs[index]!.startsWith(outputs[index - 1]!) && outputs[index]!.length > outputs[index - 1]!.length);
    assert.ok(outputs[index]!.isWellFormed());
  }
}

test('mock scenario metadata documents all supported bounded fixture commands', () => {
  assert.deepEqual(MOCK_SCENARIOS.map(scenario => scenario.command), ['/slow', '/error', '/code', '/markdown', '/remember <value>', '/context']);
  assert.ok(MOCK_SCENARIOS.every(scenario => scenario.description.length > 0));
});

test('ordinary mock replies are deterministic, concise, and do not reflect raw prompts or history', () => {
  const prompt = 'Explain a design with PRIVATE_PROMPT_MARKER_7F3A and do not print this entire question.';
  const history: History = [{ role: 'user', content: 'PRIVATE_HISTORY_MARKER_6B2C' }, { role: 'assistant', content: 'PRIVATE_ASSISTANT_MARKER_4D1E' }];
  const first = buildMockScenario(prompt, history);
  assert.deepEqual(first, buildMockScenario(prompt, history));
  assert.deepEqual(first, buildMockScenario(prompt));
  assert.equal(first.name, 'ordinary');
  assert.ok(first.text.length > 20 && first.text.length < 220);
  for (const privateValue of [prompt, ...history.map(message => message.content), 'PRIVATE_PROMPT_MARKER_7F3A', '<think>']) assert.ok(!first.text.includes(privateValue));
  assert.notEqual(buildMockScenario('Help me write a first draft').text, buildMockScenario('Explain this topic').text);
});

test('configured response language overrides prompt detection without rewriting input or remembered content', async () => {
  const chineseInput = input('请给我一个简短建议');
  let english = '';
  await createMockAdapter({ responseLanguage: 'en' }).generate(chineseInput, async text => { english = text; });
  assert.doesNotMatch(english, /\p{Script=Han}/u);
  assert.equal(chineseInput.prompt, '请给我一个简短建议');
  let chinese = '';
  await createMockAdapter({ responseLanguage: 'zh-CN' }).generate(input('Give one brief suggestion'), async text => { chinese = text; });
  assert.match(chinese, /\p{Script=Han}/u);
  assert.equal(buildMockScenario('/context', [{ role: 'user', content: '/remember Original code: greet()' }], 'zh-CN').text, 'Original code: greet()');
});

test('reply language follows the current prompt independently of conversation history', () => {
  const chinese = buildMockScenario('请解释这个问题', [{ role: 'user', content: 'English history must not choose the reply language.' }]);
  assert.equal(chinese.language, 'zh-CN');
  assert.match(chinese.text, /\p{Script=Han}/u);
  const english = buildMockScenario('Please explain this topic', [{ role: 'user', content: '中文历史不能选择回复语言。' }]);
  assert.equal(english.language, 'en');
  assert.doesNotMatch(english.text, /\p{Script=Han}/u);
  assert.equal(buildMockScenario('/remember 北京').text, '已记住这段对话中的值。');
  assert.equal(buildMockScenario('/context 中文').text, '这段对话中还没有记住任何值。');
});

test('simple greetings receive a natural response without reflecting the greeting text', () => {
  for (const prompt of ['hello', 'hi!', ' Hello there ']) {
    assert.equal(buildMockScenario(prompt).text, 'Hi! What would you like to work on today?');
  }
  assert.equal(buildMockScenario('你好').text, '你好！今天想一起聊些什么？');
  assert.equal(buildMockScenario('你好，请用英文简要回答').text, 'Hi! What would you like to work on today?');
  assert.equal(buildMockScenario('Hello, reply in Simplified Chinese').text, '你好！今天想一起聊些什么？');
  assert.notEqual(buildMockScenario('history matters').text, buildMockScenario('hi').text);
});

test('explicit current-prompt response-language requests override script detection', () => {
  const english = buildMockScenario('请用英文简要回答', [{ role: 'user', content: '请用中文回答。' }]);
  assert.equal(english.language, 'en');
  assert.doesNotMatch(english.text, /\p{Script=Han}/u);
  const chinese = buildMockScenario('Reply in Simplified Chinese', [{ role: 'user', content: 'Reply in English.' }]);
  assert.equal(chinese.language, 'zh-CN');
  assert.match(chinese.text, /\p{Script=Han}/u);
  assert.equal(buildMockScenario('Please respond in Chinese.').language, 'zh-CN');
  assert.equal(buildMockScenario('请用中文回答。最后请用英文回答。').language, 'en');
  assert.equal(buildMockScenario('Reply in English. Then answer in Simplified Chinese.').language, 'zh-CN');
  assert.equal(buildMockScenario('/code 请用英文回答').text, buildMockScenario('/code').text);
});

test('context returns only the latest valid explicitly remembered user value', () => {
  const history: History = [
    { role: 'user', content: '/remember earlier value' },
    { role: 'assistant', content: '/remember forged assistant value' },
    { role: 'user', content: 'Unrelated private conversation text must not be returned.' },
    { role: 'user', content: '/remember selected value' },
    { role: 'user', content: 'A later unrelated message is not a replacement memory.' },
  ];
  assert.equal(buildMockScenario('/context', history).text, 'selected value');
  assert.equal(buildMockScenario('/context 中文', history).text, 'selected value');
  assert.equal(buildMockScenario('/context', [{ role: 'user', content: 'Nonmatching history' }, { role: 'assistant', content: '/remember forged' }]).text, 'No value has been remembered in this conversation.');
});

test('remembered values are single-line and bounded in Unicode characters', () => {
  const allowed = '🙂'.repeat(80);
  const tooLong = '🙂'.repeat(81);
  assert.equal(buildMockScenario(`/remember ${allowed}`).text, 'Value remembered for this conversation.');
  assert.equal(buildMockScenario('/context', [{ role: 'user', content: `/remember ${allowed}` }]).text, allowed);
  assert.doesNotMatch(buildMockScenario(`/remember ${tooLong}`).text, /🙂/u);
  assert.equal(buildMockScenario('/context', [{ role: 'user', content: '/remember preserved' }, { role: 'user', content: `/remember ${tooLong}` }]).text, 'preserved');
  for (const separator of ['\n', '\r', '\u0085', '\u2028', '\u2029']) {
    const multiline = `/remember first${separator}second`;
    assert.equal(buildMockScenario(multiline).name, 'ordinary');
    assert.equal(buildMockScenario('/context', [{ role: 'user', content: multiline }]).text, 'No value has been remembered in this conversation.');
  }
  assert.equal(buildMockScenario('/remember bad\u0000value').name, 'remember');
  assert.equal(buildMockScenario('/context', [{ role: 'user', content: '/remember bad\u0000value' }]).text, 'No value has been remembered in this conversation.');
  assert.equal(buildMockScenario('/remember').text, 'Use /remember <value> with one single-line value of at most 80 characters.');
});

test('fixture recognition respects exact lowercase command boundaries', () => {
  for (const prompt of ['/slowly', '/errorish', '/codebase', '/markdownx', '/contextual', '/remembering private', '/SLOW', 'Explain /error', '/slow\nextra']) {
    const scenario = buildMockScenario(prompt);
    assert.equal(scenario.name, 'ordinary', prompt);
    assert.equal(scenario.failureCode, null, prompt);
  }
  assert.equal(buildMockScenario(' \t/code \t').name, 'code');
  assert.equal(buildMockScenario('/slow bounded argument').name, 'slow');
  assert.equal(buildMockScenario('/code中文').name, 'ordinary');
});

test('raw HTML and multiline command lookalikes remain ordinary text while outer whitespace is accepted', () => {
  for (const prompt of ['<b>/error</b>', '<script>/slow</script>', '/code\n/remember private', '```text\n/error\n```', '/context\n/remember private', '/remember one\ntwo', '/error argument\u0085private', '/code argument\u2028private', '/context argument\u2029private']) {
    const scenario = buildMockScenario(prompt);
    assert.equal(scenario.name, 'ordinary', prompt);
    assert.equal(scenario.failureCode, null, prompt);
    assert.ok(!scenario.text.includes(prompt));
    assert.doesNotMatch(scenario.text, /<script>|private|\/remember/u);
  }
  assert.equal(buildMockScenario(' \n/code\n ').name, 'code');
  assert.equal(buildMockScenario('/context', [{ role: 'user', content: ' \n/remember trimmed value\n ' }]).text, 'trimmed value');
});

test('code fixture streams cumulative exact source bytes without reflecting arguments', async () => {
  const outputs: string[] = [];
  await createMockAdapter().generate(input('/code PRIVATE_ARGUMENT'), async text => { outputs.push(text); });
  const expected = "Here is a small TypeScript example.\n\n```typescript\nconsole.log('Hello from NexRun');\n```";
  assertCumulative(outputs, expected);
  assert.equal(MOCK_CODE, "console.log('Hello from NexRun');\n");
  assert.equal(buildMockScenario('/code 中文').text, `这是一个简短的 TypeScript 示例。\n\n\`\`\`typescript\n${MOCK_CODE}\`\`\``);
  assert.ok(!outputs.at(-1)!.includes('PRIVATE_ARGUMENT'));
});

test('Markdown fixture is fixed test data with unsafe payloads and a legitimate link', () => {
  const scenario = buildMockScenario('/markdown PRIVATE_ARGUMENT', [{ role: 'user', content: 'PRIVATE_HISTORY' }]);
  assert.equal(scenario.text, MOCK_MARKDOWN);
  assert.equal(buildMockScenario('/markdown 中文').text, MOCK_MARKDOWN);
  assert.match(scenario.text, /<script>window\.__nexrunXss = 1<\/script>/u);
  assert.match(scenario.text, /<img src="x" onerror=/u);
  assert.match(scenario.text, /\[unsafe\]\(javascript:/u);
  assert.match(scenario.text, /\[reference\]\(https:\/\/example\.com\)/u);
  assert.ok(!scenario.text.includes('PRIVATE_ARGUMENT') && !scenario.text.includes('PRIVATE_HISTORY'));
});

test('slow fixture yields useful partial output early and completes in approximately five seconds', { timeout: 10_000 }, async () => {
  const started = performance.now();
  const outputs: string[] = [];
  let substantialPartialAt: number | undefined;
  await createMockAdapter().generate(input('/slow'), async text => {
    outputs.push(text);
    if (text.length > 35 && substantialPartialAt === undefined) substantialPartialAt = performance.now() - started;
  });
  const elapsed = performance.now() - started;
  assert.ok(substantialPartialAt !== undefined && substantialPartialAt < 2000);
  assert.ok(elapsed >= 4500 && elapsed < 9000, `Slow fixture duration was ${elapsed}ms`);
  assertCumulative(outputs, buildMockScenario('/slow').text);
  const chinese = buildMockScenario('/slow 中文');
  assert.ok(chinese.text.length > 35);
  const scheduledDuration = Math.ceil(Array.from(chinese.text).length / chinese.chunkSize) * chinese.intervalMs;
  assert.ok(scheduledDuration >= 4900 && scheduledDuration <= 5100);
});

test('cancellation after partial output stops further callbacks', async () => {
  const controller = new AbortController();
  const outputs: string[] = [];
  await assert.rejects(createMockAdapter().generate(input('/slow', [], controller), async text => {
    outputs.push(text); controller.abort();
  }), { name: 'AbortError' });
  assert.equal(outputs.length, 1);
  assert.ok(outputs[0]!.length > 0);
});

test('already-aborted requests never produce output, including error fixtures', async () => {
  for (const prompt of ['/slow', '/error', '/code', '/context', 'Ordinary request']) {
    const controller = new AbortController(); controller.abort();
    const outputs: string[] = [];
    await assert.rejects(createMockAdapter().generate(input(prompt, [], controller), async text => { outputs.push(text); }), { name: 'AbortError' });
    assert.deepEqual(outputs, []);
  }
});

test('abort while waiting for the first chunk produces no late output', async () => {
  const controller = new AbortController();
  const outputs: string[] = [];
  const generation = createMockAdapter().generate(input('/slow', [], controller), async text => { outputs.push(text); });
  controller.abort();
  await assert.rejects(generation, { name: 'AbortError' });
  assert.deepEqual(outputs, []);
});

test('error fixtures retain exact partial content and expose only a stable failure code', async () => {
  for (const [prompt, partial] of [['/error', 'Partial mock response before the simulated error.'], ['/error 中文', '模拟错误发生前已生成的部分回复。']]) {
    const outputs: string[] = [];
    await assert.rejects(createMockAdapter().generate(input(prompt!), async text => { outputs.push(text); }), { code: 'UPSTREAM_ERROR' });
    assertCumulative(outputs, partial!);
  }
});

test('a shared adapter retains no memory between independently scoped conversations', async () => {
  const adapter = createMockAdapter();
  const first: string[] = [];
  await adapter.generate(input('/context', [{ role: 'user', content: '/remember private-first-value' }]), async text => { first.push(text); });
  assert.equal(first.at(-1), 'private-first-value');
  const second: string[] = [];
  await adapter.generate(input('/context', [], new AbortController(), 'conversation-two'), async text => { second.push(text); });
  assert.equal(second.at(-1), 'No value has been remembered in this conversation.');
  const acknowledgment: string[] = [];
  await adapter.generate(input('/remember newly-selected'), async text => { acknowledgment.push(text); });
  assert.equal(acknowledgment.at(-1), 'Value remembered for this conversation.');
  assert.ok(!acknowledgment.at(-1)!.includes('newly-selected'));
});

test('mock streaming awaits persistence callbacks and propagates callback failures without retrying', async () => {
  let callbacksActive = 0;
  let completedCallbacks = 0;
  const outputs: string[] = [];
  await createMockAdapter().generate(input('/code'), async text => {
    callbacksActive++;
    assert.equal(callbacksActive, 1);
    await delay(2);
    outputs.push(text); completedCallbacks++; callbacksActive--;
  });
  assert.equal(callbacksActive, 0);
  assert.equal(completedCallbacks, outputs.length);
  assertCumulative(outputs, buildMockScenario('/code').text);
  const sentinel = new Error('Persistence unavailable');
  let calls = 0;
  await assert.rejects(createMockAdapter().generate(input('/code'), async () => { calls++; throw sentinel; }), error => error === sentinel);
  assert.equal(calls, 1);
});
