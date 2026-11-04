import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { PiResponseCollector } from '../src/agents/pi-response.js';
import { classifyPiDiagnostic, classifyPiError, textOnlySessionOptions } from '../src/agents/pi-host.js';

type AssistantMessage = Extract<Extract<AgentSessionEvent, { type: 'message_end' }>['message'], { role: 'assistant' }>;

function assistant(timestamp: number, content: AssistantMessage['content'] = []): AssistantMessage {
  return {
    role: 'assistant', timestamp, content, api: 'openai-responses', provider: 'openai', model: 'gpt-5-mini',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
  };
}

function update(message: AssistantMessage, type: 'text_delta' | 'thinking_delta' | 'toolcall_delta', delta: string): AgentSessionEvent {
  return { type: 'message_update', message, assistantMessageEvent: { type, contentIndex: 0, delta, partial: message } };
}

test('Pi response output excludes user messages, native history, thinking, tools, and status events', () => {
  const outputs: string[] = [];
  const collector = new PiResponseCollector((text) => outputs.push(text));
  const history = assistant(1, [{ type: 'text', text: 'HISTORICAL_ASSISTANT_TEXT' }]);
  const current = assistant(2);
  const user = { role: 'user' as const, timestamp: 2, content: 'USER_MESSAGE_NOT_AN_ANSWER' };
  const tool = { role: 'toolResult' as const, timestamp: 2, toolCallId: 'tool-one', toolName: 'disabled-tool', isError: false, content: [{ type: 'text' as const, text: 'PRIVATE_TOOL_RESULT' }] };
  const hidden: AgentSessionEvent[] = [
    { type: 'message_start', message: user },
    { type: 'message_end', message: user },
    { type: 'message_end', message: history },
    { type: 'agent_end', messages: [user, history, tool], willRetry: false },
    { type: 'turn_end', message: history, toolResults: [tool] },
    { type: 'queue_update', steering: ['PRIVATE_STEERING_INPUT'], followUp: [] },
  ];
  for (const event of hidden) collector.consume(event);
  assert.deepEqual(outputs, []);

  collector.consume({ type: 'message_start', message: current });
  const during: AgentSessionEvent[] = [
    update(current, 'thinking_delta', 'PRIVATE_REASONING'),
    update(current, 'toolcall_delta', '{"private":"tool arguments"}'),
    { type: 'tool_execution_start', toolCallId: 'tool-one', toolName: 'disabled-tool', args: { private: 'tool arguments' } },
    { type: 'tool_execution_update', toolCallId: 'tool-one', toolName: 'disabled-tool', args: {}, partialResult: 'PRIVATE_TOOL_TRACE' },
    { type: 'tool_execution_end', toolCallId: 'tool-one', toolName: 'disabled-tool', result: 'PRIVATE_TOOL_RESULT', isError: false },
    { type: 'message_end', message: tool },
    { type: 'message_end', message: history },
  ];
  for (const event of during) collector.consume(event);
  assert.deepEqual(outputs, []);
  collector.consume(update(current, 'text_delta', 'The answer is 42.'));
  assert.deepEqual(outputs, ['The answer is 42.']);
});

test('Pi canonical final text preserves exact Unicode, whitespace, and text blocks without private content', () => {
  const outputs: string[] = [];
  const collector = new PiResponseCollector((text) => outputs.push(text));
  const current = assistant(10);
  collector.consume({ type: 'message_start', message: current });
  collector.consume(update(current, 'text_delta', 'draft'));
  const canonical = '  结论：42。\n\n```text\n keep spaces  \n```\n';
  collector.consume({ type: 'message_end', message: {
    ...current,
    content: [
      { type: 'thinking', thinking: 'PRIVATE_REASONING', thinkingSignature: 'PRIVATE_THINKING_SIGNATURE' },
      { type: 'text', text: '  结论：42。\n\n' },
      { type: 'toolCall', id: 'disabled', name: 'disabled-tool', arguments: { private: 'argument' } },
      { type: 'text', text: '```text\n keep spaces  \n```\n' },
    ],
  } });
  assert.equal(collector.text, canonical);
  assert.equal(outputs.at(-1), canonical);
  assert.ok(!collector.text.includes('draft'));
  assert.ok(!collector.text.includes('PRIVATE_'));
});

test('Pi output replaces previous assistant messages instead of accumulating a transcript', () => {
  const outputs: string[] = [];
  const collector = new PiResponseCollector((text) => outputs.push(text));
  const first = assistant(20, [{ type: 'text', text: 'First answer.' }]);
  collector.consume({ type: 'message_start', message: first });
  collector.consume({ type: 'message_end', message: first });
  const second = assistant(21, [{ type: 'text', text: 'Current answer.' }]);
  collector.consume({ type: 'message_start', message: second });
  collector.consume(update(first, 'text_delta', 'STALE_HISTORY_DELTA'));
  collector.consume(update(second, 'text_delta', 'Current'));
  collector.consume({ type: 'agent_end', messages: [first, second], willRetry: false });
  collector.consume({ type: 'message_end', message: second });
  collector.consume(update(second, 'text_delta', 'LATE_TEXT'));
  assert.equal(collector.text, 'Current answer.');
  assert.deepEqual(outputs, ['First answer.', 'Current', 'Current answer.']);
});

test('Pi text output does not regex-strip ordinary quoted labels or truncate a requested explanation', () => {
  const collector = new PiResponseCollector(() => {});
  const requestedText = `The literal labels User: and Assistant: belong in this example.\n<think> is an example tag.\n${'Requested explanation. '.repeat(2_000)}`;
  const current = assistant(30, [{ type: 'text', text: requestedText }]);
  collector.consume({ type: 'message_start', message: current });
  collector.consume({ type: 'message_end', message: current });
  assert.equal(collector.text, requestedText);
});

test('Pi error details remain outside text output and are mapped to stable codes and enumerated diagnostics', () => {
  const outputs: string[] = [];
  const collector = new PiResponseCollector((text) => outputs.push(text));
  const current = assistant(40);
  collector.consume({ type: 'message_start', message: current });
  const failed: AssistantMessage = {
    ...current, stopReason: 'error', errorMessage: '401 PRIVATE_PROVIDER_RESPONSE /private/session.jsonl',
    content: [{ type: 'text', text: 'Useful partial answer.' }, { type: 'thinking', thinking: 'PRIVATE_REASONING' }],
  };
  collector.consume({ type: 'message_end', message: failed });
  assert.deepEqual(outputs, ['Useful partial answer.']);
  assert.equal(classifyPiError({ message: failed.errorMessage }), 'UPSTREAM_ERROR');
  assert.equal(classifyPiDiagnostic({ message: failed.errorMessage }), 'authentication');
});


test('Pi SDK session events carry only the current public reply through the collector without network access', async (t) => {
  let networkRequests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    networkRequests += 1;
    throw new Error('Network access is disabled in this integration test.');
  });
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { createAssistantMessageEventStream, InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
  const cwd = process.cwd();
  const manager = sdk.SessionManager.inMemory(cwd);
  manager.appendMessage({ role: 'user', timestamp: 1, content: 'PREVIOUS_USER_INPUT' });
  manager.appendMessage(assistant(2, [{ type: 'text', text: 'PREVIOUS_ASSISTANT_REPLY' }]));
  const options = await textOnlySessionOptions(sdk, cwd, cwd, manager, 'gpt-5-mini');
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('openai', async () => ({ type: 'api_key', key: 'integration-test-placeholder' }));
  options.modelRuntime = await sdk.ModelRuntime.create({
    credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  const { session } = await sdk.createAgentSession(options);
  const outputs: string[] = [];
  const collector = new PiResponseCollector((text) => outputs.push(text));
  const observed: string[] = [];
  let streamCalls = 0;
  let contextRetained = false;
  const canonical = '  Current conclusion.\n\n中文 explanation.  \n';
  session.agent.streamFunction = (_model, context) => {
    streamCalls += 1;
    contextRetained = context.messages.some((message) => message.role === 'assistant'
      && message.content.some((part) => part.type === 'text' && part.text === 'PREVIOUS_ASSISTANT_REPLY'));
    const stream = createAssistantMessageEventStream();
    const current = assistant(Date.now());
    const reasoning = { ...current, content: [{ type: 'thinking' as const, thinking: 'PRIVATE_NATIVE_REASONING' }] };
    const draft = { ...current, content: [...reasoning.content, { type: 'text' as const, text: '  Current' }] };
    const final = { ...current, content: [...reasoning.content, { type: 'text' as const, text: canonical }] };
    stream.push({ type: 'start', partial: current });
    stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'PRIVATE_NATIVE_REASONING', partial: reasoning });
    stream.push({ type: 'text_delta', contentIndex: 1, delta: '  Current', partial: draft });
    stream.push({ type: 'done', reason: 'stop', message: final });
    return stream;
  };
  const unsubscribe = session.subscribe((event) => {
    observed.push(event.type === 'message_update' ? event.assistantMessageEvent.type : event.type);
    collector.consume(event);
  });
  try {
    await session.prompt('CURRENT_USER_INPUT', { expandPromptTemplates: false });
    assert.equal(streamCalls, 1);
    assert.equal(contextRetained, true, 'Native history remains available as model context.');
    assert.equal(networkRequests, 0);
    assert.ok(observed.includes('message_start'));
    assert.ok(observed.includes('thinking_delta'));
    assert.ok(observed.includes('text_delta'));
    assert.ok(observed.includes('message_end'));
    assert.ok(observed.includes('agent_end'));
    assert.deepEqual(outputs, ['  Current', canonical]);
    assert.equal(collector.text, canonical);
    assert.ok(outputs.every((text) => !/PRIVATE_NATIVE_REASONING|PREVIOUS_|CURRENT_USER_INPUT/.test(text)));
  } finally {
    unsubscribe();
    session.dispose();
  }
});
