import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ResponseLanguage } from '@nexrun/protocol';

type AssistantMessage = Extract<Extract<AgentSessionEvent, { type: 'message_end' }>['message'], { role: 'assistant' }>;
type MessageIdentity = Pick<AssistantMessage, 'timestamp' | 'api' | 'provider' | 'model'>;

export const PI_RESPONSE_SYSTEM_PROMPT = [
  "You are NexRun's text conversation assistant.",
  "Answer the user's current request directly with the key conclusions and information they need. Be concise by default and use only relevant conversation context, without repeating the conversation.",
  'If the user explicitly asks for a deeper explanation, provide the requested detail and useful supporting rationale.',
  "Use the user's requested response language, independently of the UI locale.",
  'Do not include a whole chat transcript, internal reasoning or chain-of-thought, execution traces, or status logs in your answer. Give the user the answer rather than a replay of how it was produced.',
  'You have no tools, filesystem access, shell, browser, extensions, or external actions. Do not claim to have read files, browsed, executed commands, modified resources, or performed other actions you cannot actually perform.',
].join('\n\n');

export function piResponseSystemPrompt(language: ResponseLanguage = 'auto'): string {
  if (language === 'auto') return PI_RESPONSE_SYSTEM_PROMPT;
  return PI_RESPONSE_SYSTEM_PROMPT.replace(
    "Use the user's requested response language, independently of the UI locale.",
    `Use ${language === 'en' ? 'English' : 'Simplified Chinese'} for assistant prose, independently of the UI locale. Preserve original quotations, code, commands, identifiers, and user-provided content.`,
  );
}

/** Collect only the current assistant's public text, never aggregate session history. */
export class PiResponseCollector {
  private active: MessageIdentity | undefined;
  private currentText = '';

  constructor(private readonly onText: (text: string) => void) {}

  get text(): string { return this.currentText; }

  private matches(message: AssistantMessage): boolean {
    return this.active !== undefined && message.timestamp === this.active.timestamp
      && message.api === this.active.api && message.provider === this.active.provider && message.model === this.active.model;
  }

  /** Returns true only when this event contributes current assistant text. */
  consume(event: AgentSessionEvent): boolean {
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      const { timestamp, api, provider, model } = event.message;
      this.active = { timestamp, api, provider, model };
      this.currentText = '';
      return false;
    }
    if ((event.type !== 'message_update' && event.type !== 'message_end')
      || event.message.role !== 'assistant' || !this.matches(event.message)) return false;
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (update.type !== 'text_delta' || !this.matches(update.partial)) return false;
      this.currentText += update.delta;
    } else {
      // Native finalized text is canonical. Preserve every character from the text blocks.
      this.currentText = event.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
      this.active = undefined;
    }
    this.onText(this.currentText);
    return true;
  }
}
