import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { AcceptedMessage, ChatSnapshot, Conversation, Run } from '@nexrun/protocol';
import { buildApp } from '../src/app.js';
import { loadConfig, type ApiConfig } from '../src/config.js';
import { ChatStore } from '../src/store.js';
import type { AgentAdapter, AgentInput } from '../src/agents/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://nexrun:nexrun@127.0.0.1:55439/nexrun';
const headers = { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173' };

async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, timeout = 4_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (accept(result)) return result;
    await delay(10);
  }
  throw new Error('Timed out waiting for the expected execution state.');
}

class ControlledAdapter implements AgentAdapter {
  mode = 'mock' as const;
  configured = true;
  model = null;
  jobs = new Map<string, { input: AgentInput; onText: (text: string) => Promise<void>; resolve: () => void }>();
  inputs: AgentInput[] = [];
  async generate(input: AgentInput, onText: (text: string) => Promise<void>): Promise<void> {
    this.inputs.push(input);
    await onText('Partial response');
    await new Promise<void>((resolve, reject) => {
      this.jobs.set(input.runId, { input, onText, resolve });
      if (input.signal.aborted) reject(new Error('Aborted.'));
      else input.signal.addEventListener('abort', () => reject(new Error('Aborted.')), { once: true });
    });
  }
  async complete(runId: string, content = 'Completed response'): Promise<void> {
    const job = await until(() => this.jobs.get(runId), (value) => value !== undefined);
    await job!.onText(content);
    job!.resolve();
  }
}

interface Fixture { app: FastifyInstance; pool: Pool; config: ApiConfig; adapter: AgentAdapter; request: (options: InjectOptions) => Promise<LightMyRequestResponse> }
async function fixture(t: TestContext, adapter: AgentAdapter = new ControlledAdapter(), overrides: Partial<ApiConfig> = {}): Promise<Fixture> {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
  const stateDir = join(tmpdir(), `nexrun-api-${schema}`);
  const config: ApiConfig = { ...loadConfig({}), stateDir, generationTimeoutMs: 10_000, eventPollMs: 10, eventHeartbeatMs: 100, ...overrides };
  const result: Fixture = {
    app: await buildApp({ pool, adapter, config }), pool, config, adapter,
    request(options) { return result.app.inject({ ...options, headers: { ...headers, ...options.headers } }); },
  };
  t.after(async () => {
    await result.app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(stateDir, { recursive: true, force: true });
  });
  return result;
}
async function conversation(f: Fixture): Promise<Conversation> {
  const result = await f.request({ method: 'POST', url: '/api/conversations', payload: {} });
  assert.equal(result.statusCode, 201);
  return result.json();
}
async function send(f: Fixture, conversationId: string, content: string, key = randomUUID()): Promise<AcceptedMessage> {
  const result = await f.request({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, payload: { content }, headers: { 'idempotency-key': key } });
  assert.equal(result.statusCode, 202, result.body);
  return result.json();
}
async function terminal(f: Fixture, id: string): Promise<Run> {
  return until(async () => (await f.request({ method: 'GET', url: `/api/runs/${id}` })).json<Run>(), (run) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status));
}

test('same-key concurrent submissions are one logical Run; conflicts precede busy rejection', async (t) => {
  const f = await fixture(t);
  const chat = await conversation(f);
  const options: InjectOptions = { method: 'POST', url: `/api/conversations/${chat.id}/messages`, payload: { content: 'First request' }, headers: { 'idempotency-key': 'same-request' } };
  const [first, duplicate] = await Promise.all([f.request(options), f.request(options)]);
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.statusCode, 202);
  assert.equal(first.json<AcceptedMessage>().run.id, duplicate.json<AcceptedMessage>().run.id);
  const counts = await f.pool.query('SELECT (SELECT count(*) FROM messages)::int AS messages, (SELECT count(*) FROM runs)::int AS runs, (SELECT count(*) FROM command_outbox)::int AS commands');
  assert.deepEqual(counts.rows[0], { messages: 2, runs: 1, commands: 1 });
  const changed = await f.request({ ...options, payload: { content: 'Changed request' } });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, 'IDEMPOTENCY_CONFLICT');
  const busy = await f.request({ ...options, headers: { 'idempotency-key': 'new-request' } });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().error.code, 'CONVERSATION_BUSY');
});

test('an outbox failure rolls back messages, Run, title, sequence, and acceptance event', async (t) => {
  const f = await fixture(t);
  const chat = await conversation(f);
  await f.pool.query("CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected transaction failure'; END $$; CREATE TRIGGER reject_outbox BEFORE INSERT ON command_outbox FOR EACH ROW EXECUTE FUNCTION reject_outbox()");
  const result = await f.request({ method: 'POST', url: `/api/conversations/${chat.id}/messages`, payload: { content: 'Private text must never appear in errors' }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(result.statusCode, 500);
  assert.deepEqual(result.json(), { error: { code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR' } });
  const counts = await f.pool.query('SELECT (SELECT count(*) FROM messages)::int AS messages, (SELECT count(*) FROM runs)::int AS runs, (SELECT count(*) FROM conversation_events)::int AS events, (SELECT count(*) FROM command_outbox)::int AS commands');
  assert.deepEqual(counts.rows[0], { messages: 0, runs: 0, events: 0, commands: 0 });
  const state = await f.pool.query('SELECT title, next_message_order, event_sequence FROM conversations WHERE id = $1', [chat.id]);
  assert.deepEqual(state.rows[0], { title: 'New chat', next_message_order: 0, event_sequence: '0' });
});

test('cancellation preserves partial content, settles once, and ignores late updates', async (t) => {
  const adapter = new ControlledAdapter();
  const f = await fixture(t, adapter);
  const chat = await conversation(f);
  const accepted = await send(f, chat.id, 'Slow response');
  await until(() => adapter.jobs.has(accepted.run.id), Boolean);
  const cancelled = await f.request({ method: 'POST', url: `/api/runs/${accepted.run.id}/cancel`, payload: {} });
  assert.ok(['cancelling', 'cancelled'].includes(cancelled.json<Run>().status));
  assert.equal((await terminal(f, accepted.run.id)).status, 'cancelled');
  await adapter.jobs.get(accepted.run.id)!.onText('Late provider text');
  const twice = await f.request({ method: 'POST', url: `/api/runs/${accepted.run.id}/cancel`, payload: {} });
  assert.equal(twice.json<Run>().status, 'cancelled');
  const snapshot = (await f.request({ method: 'GET', url: `/api/conversations/${chat.id}/messages` })).json<ChatSnapshot>();
  assert.equal(snapshot.messages[1]!.content, 'Partial response');
  assert.equal(snapshot.messages[1]!.status, 'cancelled');
  const terminalEvents = await f.pool.query("SELECT count(*)::int AS count FROM conversation_events WHERE conversation_id = $1 AND type = 'run.updated' AND payload->'run'->>'status' = 'cancelled'", [chat.id]);
  assert.equal(terminalEvents.rows[0].count, 1);
});

test('Stop cannot overwrite a completed Run; archive protects active work', async (t) => {
  const adapter = new ControlledAdapter();
  const f = await fixture(t, adapter);
  const chat = await conversation(f);
  const accepted = await send(f, chat.id, 'Finish normally');
  const activeArchive = await f.request({ method: 'PATCH', url: `/api/conversations/${chat.id}`, payload: { archived: true } });
  assert.equal(activeArchive.statusCode, 409);
  await adapter.complete(accepted.run.id);
  assert.equal((await terminal(f, accepted.run.id)).status, 'completed');
  assert.equal((await f.request({ method: 'POST', url: `/api/runs/${accepted.run.id}/cancel`, payload: {} })).json<Run>().status, 'completed');
  const archived = await f.request({ method: 'PATCH', url: `/api/conversations/${chat.id}`, payload: { archived: true } });
  assert.ok(archived.json<Conversation>().archivedAt);
  assert.equal((await f.request({ method: 'GET', url: '/api/conversations' })).json().conversations.length, 0);
  assert.equal((await f.request({ method: 'GET', url: `/api/conversations/${chat.id}/messages` })).json<ChatSnapshot>().messages[1]!.content, 'Completed response');
});

test('native completion observed before Stop remains completed while host termination settles', async (t) => {
  let releaseExit: (() => void) | undefined;
  t.after(() => { releaseExit?.(); });
  const adapter: AgentAdapter = {
    mode: 'mock', configured: true, model: null,
    async generate(_input, onText) {
      await onText('Native completed response');
      await new Promise<void>((resolve) => { releaseExit = resolve; });
    },
  };
  const f = await fixture(t, adapter);
  const chat = await conversation(f);
  const accepted = await send(f, chat.id, 'Finish before host exit');
  await until(() => releaseExit !== undefined, Boolean);
  const stop = await f.request({ method: 'POST', url: `/api/runs/${accepted.run.id}/cancel`, payload: {} });
  assert.equal(stop.json<Run>().status, 'cancelling');
  releaseExit!();
  assert.equal((await terminal(f, accepted.run.id)).status, 'completed');
});

test('history pagination is ascending and nonoverlapping; snapshot cursor represents persisted content', async (t) => {
  const adapter = new ControlledAdapter();
  const f = await fixture(t, adapter);
  const chat = await conversation(f);
  for (let index = 0; index < 3; index++) {
    const accepted = await send(f, chat.id, `Turn ${index}`);
    await adapter.complete(accepted.run.id, `Reply ${index}`);
    await terminal(f, accepted.run.id);
  }
  const latest = (await f.request({ method: 'GET', url: `/api/conversations/${chat.id}/messages?limit=2` })).json<ChatSnapshot>();
  const middle = (await f.request({ method: 'GET', url: `/api/conversations/${chat.id}/messages?limit=2&before=${latest.nextCursor}` })).json<ChatSnapshot>();
  const oldest = (await f.request({ method: 'GET', url: `/api/conversations/${chat.id}/messages?limit=2&before=${middle.nextCursor}` })).json<ChatSnapshot>();
  assert.deepEqual([...oldest.messages, ...middle.messages, ...latest.messages].map((message) => message.order), [1, 2, 3, 4, 5, 6]);
  assert.equal(oldest.nextCursor, null);
  assert.equal(latest.cursor, middle.cursor);
  const events = await new ChatStore(f.pool, f.config).events(chat.id, 0);
  assert.equal(events.at(-1)!.sequence, latest.cursor);
  assert.equal(events.at(-1)!.payload.message!.content, latest.messages[1]!.content);
});

test('service concurrency is bounded across conversations, not just per chat', async (t) => {
  const f = await fixture(t, new ControlledAdapter(), { maxConcurrentRuns: 1 });
  const first = await conversation(f);
  const second = await conversation(f);
  await send(f, first.id, 'Keep running');
  const result = await f.request({ method: 'POST', url: `/api/conversations/${second.id}/messages`, payload: { content: 'Excess work' }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(result.statusCode, 429);
  assert.equal(result.json().error.code, 'SERVICE_BUSY');
});

test('startup interrupts old queued and running records without replaying model requests', async (t) => {
  const f = await fixture(t);
  const queuedChat = await conversation(f);
  const runningChat = await conversation(f);
  await f.app.close();
  const store = new ChatStore(f.pool, f.config);
  const queued = await store.acceptMessage(queuedChat.id, 'Accepted but not dispatched', randomUUID(), true);
  const running = await store.acceptMessage(runningChat.id, 'Previously running', randomUUID(), true);
  const work = await store.startRun(running.run.id);
  await store.updateAssistant(running.run.id, work!.attemptId, 'Persisted before interruption');
  const nextAdapter = new ControlledAdapter();
  f.app = await buildApp({ pool: f.pool, config: f.config, adapter: nextAdapter });
  assert.equal((await terminal(f, queued.run.id)).status, 'interrupted');
  assert.equal((await terminal(f, running.run.id)).status, 'interrupted');
  await delay(50);
  assert.equal(nextAdapter.inputs.length, 0);
  const snapshot = (await f.request({ method: 'GET', url: `/api/conversations/${runningChat.id}/messages` })).json<ChatSnapshot>();
  assert.equal(snapshot.messages[1]!.content, 'Persisted before interruption');
  const outbox = await f.pool.query("SELECT count(*)::int AS count FROM command_outbox WHERE state <> 'retired'");
  assert.equal(outbox.rows[0].count, 0);
});

test('Host/Origin and owner boundaries apply to commands, history, Runs, and SSE', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request({ method: 'POST', url: '/api/conversations', payload: {}, headers: { origin: 'https://untrusted.example' } })).statusCode, 403);
  assert.equal((await f.request({ method: 'GET', url: '/healthz', headers: { host: 'rebound.example:3001' } })).statusCode, 403);
  const foreign = new ChatStore(f.pool, { ...f.config, ownerId: 'another-owner' });
  const chat = await foreign.createConversation();
  const accepted = await foreign.acceptMessage(chat.id, 'Foreign content', randomUUID(), true);
  for (const url of [`/api/conversations/${chat.id}/messages`, `/api/conversations/${chat.id}/events?after=0`, `/api/runs/${accepted.run.id}`]) {
    assert.equal((await f.request({ method: 'GET', url })).statusCode, 404);
  }
  assert.equal((await f.request({ method: 'POST', url: `/api/runs/${accepted.run.id}/cancel`, payload: {} })).statusCode, 404);
  assert.equal((await f.request({ method: 'GET', url: '/api/conversations' })).json().conversations.length, 0);
  assert.deepEqual((await f.request({ method: 'GET', url: '/api/config' })).json(), { adapter: 'mock', configured: true, model: null, responseLanguage: 'auto' });
});

test('invalid and expired event cursors require explicit resynchronization', async (t) => {
  const f = await fixture(t);
  const chat = await conversation(f);
  await send(f, chat.id, 'Cursor test');
  const future = await f.request({ method: 'GET', url: `/api/conversations/${chat.id}/events?after=999999` });
  assert.equal(future.statusCode, 409);
  assert.equal(future.json().error.code, 'RESYNC_REQUIRED');
  await f.pool.query('DELETE FROM conversation_events WHERE conversation_id = $1 AND sequence = 1', [chat.id]);
  const expired = await f.request({ method: 'GET', url: `/api/conversations/${chat.id}/events?after=0` });
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().error.code, 'RESYNC_REQUIRED');
  assert.equal((await f.request({ method: 'GET', url: `/api/conversations/${chat.id}/events?after=-1` })).statusCode, 400);
});

test('SSE replays accepted work and delivers a terminal event without duplicate IDs', async (t) => {
  const adapter = new ControlledAdapter();
  const f = await fixture(t, adapter);
  const chat = await conversation(f);
  const snapshot = (await f.request({ method: 'GET', url: `/api/conversations/${chat.id}/messages` })).json<ChatSnapshot>();
  const accepted = await send(f, chat.id, 'Stream replay');
  await until(() => adapter.jobs.has(accepted.run.id), Boolean);
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  f.config.allowedHosts.push(new URL(address).host);
  const controller = new AbortController();
  const response = await fetch(`${address}/api/conversations/${chat.id}/events?after=${snapshot.cursor}`, { signal: controller.signal, headers: { origin: headers.origin } });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  t.after(() => { controller.abort(); });
  const decoder = new TextDecoder();
  let output = '';
  while (!output.includes('message.accepted')) output += decoder.decode((await reader.read()).value, { stream: true });
  await adapter.complete(accepted.run.id);
  while (!output.includes('"status":"completed"')) output += decoder.decode((await reader.read()).value, { stream: true });
  const ids = [...output.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(ids, [...new Set(ids)].sort((a, b) => a - b));
  assert.equal(ids[0], snapshot.cursor + 1);
  controller.abort();
  await reader.cancel().catch(() => undefined);
});

test('generation timeout and output limits retain bounded partial content', async (t) => {
  const f = await fixture(t, new ControlledAdapter(), { generationTimeoutMs: 100 });
  const chat = await conversation(f);
  const accepted = await send(f, chat.id, 'Timeout');
  const timedOut = await terminal(f, accepted.run.id);
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.errorCode, 'GENERATION_TIMEOUT');
  const oversized: AgentAdapter = { mode: 'mock', configured: true, model: null, async generate(_input, onText) { await onText('x'.repeat(100)); } };
  const bounded = await fixture(t, oversized, { maxOutputCharacters: 25 });
  const other = await conversation(bounded);
  const work = await send(bounded, other.id, 'Output bound');
  assert.equal((await terminal(bounded, work.run.id)).errorCode, 'OUTPUT_LIMIT_EXCEEDED');
  assert.equal((await bounded.request({ method: 'GET', url: `/api/conversations/${other.id}/messages` })).json<ChatSnapshot>().messages[1]!.content.length, 25);
});

test('native input history is scoped to its own conversation and excludes the current turn', async (t) => {
  const adapter = new ControlledAdapter();
  const f = await fixture(t, adapter);
  const first = await conversation(f);
  const second = await conversation(f);
  const initial = await send(f, first.id, 'Private first conversation');
  await adapter.complete(initial.run.id);
  await terminal(f, initial.run.id);
  const continuation = await send(f, first.id, 'Continue');
  const separate = await send(f, second.id, 'Other conversation');
  await until(() => adapter.inputs.length, (length) => length === 3);
  assert.deepEqual(adapter.inputs.find((input) => input.runId === continuation.run.id)!.history.map((message) => message.content), ['Private first conversation', 'Completed response']);
  assert.deepEqual(adapter.inputs.find((input) => input.runId === separate.run.id)!.history, []);
});

test('recent conversation pages have stable ties and renamed titles survive the first message', async (t) => {
  const f = await fixture(t);
  const chats = await Promise.all([conversation(f), conversation(f), conversation(f)]);
  await f.pool.query("UPDATE conversations SET updated_at = '2026-11-04T00:00:00Z'");
  const fullPage = (await f.request({ method: 'GET', url: '/api/conversations?limit=3' })).json<{ conversations: Conversation[] }>();
  assert.deepEqual(fullPage.conversations.map((chat) => chat.id), chats.map((chat) => chat.id).sort().reverse());
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = (await f.request({ method: 'GET', url: `/api/conversations?limit=1${cursor ? `&cursor=${cursor}` : ''}` })).json<{ conversations: Conversation[]; nextCursor: string | null }>();
    seen.push(...page.conversations.map((chat) => chat.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, chats.map((chat) => chat.id).sort().reverse());
  const renamed = await f.request({ method: 'PATCH', url: `/api/conversations/${chats[0]!.id}`, payload: { title: 'Chosen title' } });
  assert.equal(renamed.json<Conversation>().title, 'Chosen title');
  await send(f, chats[0]!.id, 'A different automatic title');
  assert.equal((await f.pool.query('SELECT title FROM conversations WHERE id = $1', [chats[0]!.id])).rows[0].title, 'Chosen title');
});

test('switching adapters keeps old history readable and refuses implicit context migration', async (t) => {
  const adapter = new ControlledAdapter();
  const f = await fixture(t, adapter);
  const chat = await conversation(f);
  const accepted = await send(f, chat.id, 'Native scope');
  await adapter.complete(accepted.run.id);
  await terminal(f, accepted.run.id);
  await f.app.close();
  const piFixture: AgentAdapter = { mode: 'pi', configured: true, model: 'fixture', async generate(_input, onText) { await onText('New Pi conversation'); } };
  f.app = await buildApp({ pool: f.pool, config: f.config, adapter: piFixture });
  const history = await f.request({ method: 'GET', url: `/api/conversations/${chat.id}/messages` });
  assert.equal(history.json<ChatSnapshot>().messages.length, 2);
  const mismatch = await f.request({ method: 'POST', url: `/api/conversations/${chat.id}/messages`, payload: { content: 'Do not lose native context' }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.json().error.code, 'AGENT_SESSION_MISMATCH');
});

test('startup cannot retire old work until Adapter host reconciliation succeeds', async (t) => {
  const f = await fixture(t);
  const chat = await conversation(f);
  await f.app.close();
  const store = new ChatStore(f.pool, f.config);
  const accepted = await store.acceptMessage(chat.id, 'Old accepted work', randomUUID(), true);
  const uncertain: AgentAdapter = {
    mode: 'mock', configured: true, model: null,
    async reconcile() { throw new Error('Host termination is unconfirmed.'); },
    async generate() { throw new Error('Must not dispatch.'); },
  };
  await assert.rejects(buildApp({ pool: f.pool, config: f.config, adapter: uncertain }), /Host termination is unconfirmed/);
  assert.equal((await store.getRun(accepted.run.id)).status, 'queued');
  let observedBeforeReconciliation = false;
  const reconciled: AgentAdapter = {
    mode: 'mock', configured: true, model: null,
    async reconcile() { observedBeforeReconciliation = (await store.getRun(accepted.run.id)).status === 'queued'; },
    async generate() { throw new Error('Must not replay.'); },
  };
  f.app = await buildApp({ pool: f.pool, config: f.config, adapter: reconciled });
  assert.equal(observedBeforeReconciliation, true);
  assert.equal((await store.getRun(accepted.run.id)).status, 'interrupted');
});
