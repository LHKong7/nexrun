import assert from 'node:assert/strict';
import test from 'node:test';
import { executeSandboxedOperation, inspectSandbox, seatbeltProfile } from '../src/agents/sandbox.js';
import { assertContextBudget, createWorkspaceTools, workspaceToolAliases } from '../src/agents/workspace-tools.js';
import { configureWorkspaceSessionOptions, installContextBudget, textOnlySessionOptions } from '../src/agents/pi-host.js';

test('context budget includes native history, system declarations and UTF-8 tool results', () => {
  assert.throws(() => assertContextBudget([{ role: 'system', content: 'rule' }, { role: 'toolResult', content: '文'.repeat(2000) }], 4096), { code: 'CONTEXT_LIMIT' });
  const usage = assertContextBudget([{ role: 'user', content: 'bounded task' }], 8192);
  assert.equal(usage.accounting, 'conservative-byte-estimate');
  assert.ok(usage.estimatedInputTokens > 0);
  assert.equal(usage.outputReserve, 4096);
});

test('custom tool aliases preserve the internal allowlist and broker operation identity', async () => {
  assert.deepEqual(workspaceToolAliases(['file.list', 'file.write']), ['file_list', 'file_write']);
  const operations: unknown[] = [];
  const tools = createWorkspaceTools(['file.read'], async operation => { operations.push(operation); return { revision: 3, content: 'hello' }; });
  const result = await tools[0]!.execute('call-1', { path: 'README.md' }, undefined, undefined, undefined as never);
  assert.deepEqual(operations, [{ id: 'call-1', name: 'file.read', args: { path: 'README.md' } }]);
  assert.match(JSON.stringify(result), /hello/);
  assert.throws(() => createWorkspaceTools(['file.read', 'file.read'], async () => ({})), { code: 'TOOL_NOT_ALLOWED' });
});

test('native sandbox profile grants no network or write authority', () => {
  const profile = seatbeltProfile('/usr/local/bin/node');
  assert.match(profile, /\(deny default\)/);
  assert.doesNotMatch(profile, /allow network|allow file-write|allow process-fork/);
  assert.throws(() => seatbeltProfile('/usr/bin/node\n(allow default)'), { code: 'SANDBOX_UNAVAILABLE' });
});

test('native sandbox denies host reads, writes, networking and subprocesses', async () => {
  if (process.platform !== 'darwin') {
    await assert.rejects(inspectSandbox(), { code: 'SANDBOX_UNAVAILABLE' });
    return;
  }
  assert.deepEqual(await inspectSandbox(), { provider: 'macos-seatbelt', hostReadDenied: true, dataAliasReadDenied: true, symlinkReadDenied: true, hostWriteDenied: true, subprocessDenied: true, networkDenied: true });
});

test('sandboxed file workflow edits only its snapshot and rejects traversal and excessive results', async () => {
  if (process.platform !== 'darwin') {
    await assert.rejects(executeSandboxedOperation([], { id: 'call-1', name: 'file.list', args: {} }), { code: 'SANDBOX_UNAVAILABLE' });
    return;
  }
  const files = [{ path: 'docs/guide.md', content: 'first\nsecond' }];
  const read = await executeSandboxedOperation(files, { id: 'call-1', name: 'file.read', args: { path: 'docs/guide.md' } });
  assert.deepEqual(read.result, { path: 'docs/guide.md', content: 'first\nsecond' });
  const edited = await executeSandboxedOperation(files, { id: 'call-2', name: 'file.write', args: { path: 'docs/guide.md', content: 'updated', expectedRevision: 1 } });
  assert.deepEqual(edited.files, [{ path: 'docs/guide.md', content: 'updated' }]);
  assert.equal(files[0]!.content, 'first\nsecond');
  const hidden = await executeSandboxedOperation([{ path: '.gitignore', content: 'node_modules' }], { id: 'call-hidden', name: 'file.list', args: {} });
  assert.deepEqual(hidden.result, { paths: ['.gitignore'] });
  const unicodeFiles = [{ path: 'first.txt', content: '文'.repeat(20000) }, { path: 'second.txt', content: '字'.repeat(20000) }];
  const unicode = await executeSandboxedOperation(unicodeFiles, { id: 'call-unicode', name: 'file.list', args: {} });
  assert.deepEqual(unicode.files, unicodeFiles);
  await assert.rejects(executeSandboxedOperation(files, { id: 'call-3', name: 'file.read', args: { path: '../outside' } }), { code: 'WORKSPACE_PATH_INVALID' });
  await assert.rejects(executeSandboxedOperation([{ path: 'large.txt', content: 'x'.repeat(33000) }], { id: 'call-4', name: 'file.read', args: { path: 'large.txt' } }), { code: 'WORKSPACE_RESULT_LIMIT' });
});

test('real SDK activates only brokered file tools and completes a synthetic tool loop without network', async () => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const { createAssistantMessageEventStream, InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
  const cwd = process.cwd();
  const options = await textOnlySessionOptions(sdk, cwd, cwd, sdk.SessionManager.inMemory(cwd), 'gpt-5-mini');
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('openai', async () => ({ type: 'api_key', key: 'test-placeholder' }));
  options.modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const operations: unknown[] = [];
  configureWorkspaceSessionOptions(options, { sessionKey: 'scope-one', contextEpoch: 1, roleInstructions: 'Inspect documents carefully.', resourcesText: '', toolNames: ['file.read'], contextBudget: 96000 }, async operation => { operations.push(operation); return { revision: 2, result: { content: 'workspace content' } }; });
  const { session } = await sdk.createAgentSession(options);
  installContextBudget(session, options, 96000);
  let calls = 0;
  session.agent.streamFunction = () => {
    calls += 1;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: 'assistant' as const, timestamp: Date.now(), api: 'openai-responses' as const, provider: 'openai', model: 'gpt-5-mini',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: calls === 1 ? [{ type: 'toolCall' as const, id: 'call-read', name: 'file_read', arguments: { path: 'docs/guide.md' } }] : [{ type: 'text' as const, text: 'Read complete.' }],
      stopReason: calls === 1 ? 'toolUse' as const : 'stop' as const,
    };
    stream.push({ type: 'done', reason: calls === 1 ? 'toolUse' : 'stop', message });
    return stream;
  };
  try {
    assert.deepEqual(session.getActiveToolNames(), ['file_read']);
    assert.match(session.systemPrompt, /Inspect documents carefully/);
    assert.deepEqual(options.resourceLoader!.getExtensions().extensions, []);
    assert.deepEqual(options.resourceLoader!.getSkills().skills, []);
    await session.prompt('Read docs/guide.md', { expandPromptTemplates: false });
    assert.equal(calls, 2);
    assert.deepEqual(operations, [{ id: 'call-read', name: 'file.read', args: { path: 'docs/guide.md' } }]);
  } finally { session.dispose(); }
});

test('full native history and role instructions exceed the budget before any provider stream starts', async () => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const cwd = process.cwd();
  const manager = sdk.SessionManager.inMemory(cwd);
  manager.appendMessage({ role: 'user', timestamp: 1, content: 'history'.repeat(3000) });
  const options = await textOnlySessionOptions(sdk, cwd, cwd, manager, 'gpt-5-mini');
  configureWorkspaceSessionOptions(options, { sessionKey: 'scope-two', contextEpoch: 1, roleInstructions: 'Role instructions', resourcesText: '', toolNames: ['file.read'], contextBudget: 8192 }, async () => ({}));
  const { session } = await sdk.createAgentSession(options);
  installContextBudget(session, options, 8192);
  let calls = 0;
  session.agent.streamFunction = () => { calls += 1; throw new Error('Provider stream must not start.'); };
  try {
    await session.prompt('A short new prompt', { expandPromptTemplates: false }).catch(error => { assert.match(String(error), /CONTEXT_LIMIT/); });
    assert.equal(calls, 0);
    const last = session.messages.at(-1);
    assert.ok(last?.role === 'assistant' && last.stopReason === 'error' && last.errorMessage?.includes('CONTEXT_LIMIT'));
  } finally { session.dispose(); }
});
