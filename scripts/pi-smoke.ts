import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiAdapter, piConversationDirectory, selectedPiApiKey } from '../apps/api/src/agents/pi.js';

if (process.env.RUN_PI_SMOKE !== '1') {
  console.log('Pi integration smoke skipped. Set RUN_PI_SMOKE=1 to make configured model requests.');
} else if (!selectedPiApiKey()) {
  console.error('AGENT_NOT_CONFIGURED: Pi smoke requires a server-side NEXRUN_OPENAI_API_KEY or OPENAI_API_KEY.');
  process.exitCode = 1;
} else {
  const stateDir = await mkdtemp(join(tmpdir(), 'nexrun-pi-smoke-'));
  const conversationId = randomUUID();
  const marker = `nexrun-${randomUUID()}`;
  const adapter = createPiAdapter({ stateDir, generationTimeoutMs: 120_000 });
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const turn = async (id: string, prompt: string, prior = history): Promise<string> => {
    let text = '';
    await adapter.generate({ conversationId: id, runId: randomUUID(), prompt, history: prior, signal: new AbortController().signal }, async (snapshot) => {
      assert.ok(snapshot.startsWith(text), 'Text callbacks must contain cumulative full text.');
      text = snapshot;
    });
    assert.ok(text.length > 0, 'The configured model must produce a text reply.');
    return text;
  };
  try {
    const firstPrompt = `Remember this exact private test marker: ${marker}. Reply only with ACK.`;
    const first = await turn(conversationId, firstPrompt);
    history.push({ role: 'user', content: firstPrompt }, { role: 'assistant', content: first });
    const second = await turn(conversationId, 'What exact private test marker did I ask you to remember? Reply only with the marker.');
    assert.ok(second.includes(marker), 'A second native session host must retain the same conversation context.');
    const otherId = randomUUID();
    const isolated = await turn(otherId, 'What private test marker did I ask you to remember earlier in this conversation? If none was provided, reply only UNKNOWN.', []);
    assert.ok(!isolated.includes(marker), 'Another conversation must not inherit native context.');

    const originalDirectory = piConversationDirectory(stateDir, conversationId);
    const otherDirectory = piConversationDirectory(stateDir, otherId);
    const originalManifest = JSON.parse(await readFile(join(originalDirectory, 'native-session.json'), 'utf8'));
    const otherManifest = JSON.parse(await readFile(join(otherDirectory, 'native-session.json'), 'utf8'));
    assert.notEqual(originalManifest.nativeSessionId, otherManifest.nativeSessionId);
    assert.equal((await stat(originalDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(originalManifest.nativeSessionFile)).mode & 0o777, 0o600);

    const cancellation = new AbortController();
    let partial = '';
    const abortTimer = setTimeout(() => cancellation.abort(), 15_000);
    try {
      await assert.rejects(adapter.generate({
        conversationId: randomUUID(), runId: randomUUID(),
        prompt: 'Write a very long numbered list of 10000 simple English words, one word per line.',
        history: [], signal: cancellation.signal,
      }, async (text) => { partial = text; cancellation.abort(); }), { name: 'AbortError' });
    } finally { clearTimeout(abortTimer); }
    const invalidModel = createPiAdapter({ stateDir, model: 'nexrun-nonexistent-model', generationTimeoutMs: 30_000 });
    try {
      await assert.rejects(invalidModel.generate({
        conversationId: randomUUID(), runId: randomUUID(), prompt: 'Hello', history: [], signal: new AbortController().signal,
      }, async () => {}), { code: 'AGENT_NOT_CONFIGURED', message: 'AGENT_NOT_CONFIGURED' });
    } finally { await invalidModel.dispose?.(); }
    // Test prompts, model replies, credentials, native IDs and paths stay out of the run log.
    console.log(JSON.stringify({ mode: 'pi', model: adapter.model, twoTurnContext: 'passed', conversationIsolation: 'passed', cancellation: 'passed', partialOutputObserved: partial.length > 0, nativePersistence: 'passed', configurationFailure: 'passed' }));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'PI_SMOKE_FAILED';
    const category = error && typeof error === 'object' && 'diagnostic' in error ? error.diagnostic : 'unknown';
    const diagnostic = typeof category === 'string' && ['authentication', 'rate_limit', 'network', 'configuration', 'unknown'].includes(category) ? category : 'unknown';
    console.error(JSON.stringify({ mode: 'pi', result: 'failed', code: /^[A-Z_]+$/.test(code) ? code : 'PI_SMOKE_FAILED', diagnostic }));
    process.exitCode = 1;
  } finally {
    await adapter.dispose?.();
    await rm(stateDir, { recursive: true, force: true });
  }
}
