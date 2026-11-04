import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Pool } from 'pg';
import type { Message } from '@nexrun/protocol';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db.js';
import { assertDemoConfiguration, demoConversations, demoId, seedDemo } from '../src/demo-fixtures.js';
import { ChatStore } from '../src/store.js';
import { createMockAdapter } from '../src/agents/mock.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://nexrun:nexrun@127.0.0.1:55439/nexrun';
async function fixture(t: TestContext) {
  const schema = `nexrun_demo_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5, connectionTimeoutMillis: 5_000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await migrate(pool);
  const config = { ...loadConfig({}), databaseUrl };
  return { pool, config, store: new ChatStore(pool, config) };
}

test('demo import provides bilingual, code, empty, archived and paginated historical chats without live work', async (t) => {
  const { pool, config, store } = await fixture(t);
  assert.deepEqual(await seedDemo(pool, config), { created: 7, skipped: 0 });
  const listed = await store.listConversations(100);
  assert.equal(listed.conversations.length, 6);
  assert.ok(listed.conversations.every(chat => chat.activeRun === null));
  assert.ok(!listed.conversations.some(chat => chat.id === demoId('archived')));
  assert.equal((await store.snapshot(demoId('empty'), 50)).messages.length, 0);
  assert.match((await store.snapshot(demoId('chinese'), 50)).messages[1]!.content, /本次发布重点/);
  assert.match((await store.snapshot(demoId('code'), 50)).messages[1]!.content, /```typescript\nexport function greet/);
  assert.equal((await store.snapshot(demoId('archived'), 50)).messages.length, 2);

  const messages: Message[] = [];
  let before: number | undefined;
  do {
    const page = await store.snapshot(demoId('history'), 50, before);
    messages.unshift(...page.messages);
    before = page.nextCursor ?? undefined;
  } while (before !== undefined);
  assert.equal(messages.length, 120);
  assert.equal(new Set(messages.map(message => message.id)).size, 120);
  assert.deepEqual(messages.map(message => message.order), Array.from({ length: 120 }, (_, index) => index + 1));
  assert.match(messages[0]!.content, /checkpoint 01/);
  assert.match(messages.at(-1)!.content, /Checkpoint 60/);
  const sequences: number[] = [];
  let cursor = 0;
  while (true) {
    const batch = await store.events(demoId('history'), cursor);
    if (!batch.length) break;
    sequences.push(...batch.map(event => event.sequence));
    cursor = batch.at(-1)!.sequence;
  }
  assert.deepEqual(sequences, Array.from({ length: 240 }, (_, index) => index + 1));
  const live = await pool.query("SELECT (SELECT count(*)::int FROM runs WHERE status IN ('queued','running','cancelling')) AS runs, (SELECT count(*)::int FROM command_outbox WHERE state <> 'retired') AS commands");
  assert.deepEqual(live.rows[0], { runs: 0, commands: 0 });
});

test('an imported nonempty conversation can continue through the mock adapter without replaying its transcript', async (t) => {
  const { pool, config, store } = await fixture(t);
  await seedDemo(pool, config);
  const adapter = createMockAdapter();
  const turn = async (prompt: string) => {
    const accepted = await store.acceptMessage(demoId('release'), prompt, randomUUID(), true);
    const started = await store.startRun(accepted.run.id);
    assert.ok(started);
    let text = '';
    await adapter.generate({ conversationId: demoId('release'), runId: accepted.run.id, prompt: started.prompt, history: started.history, signal: new AbortController().signal }, async snapshot => {
      text = snapshot;
      await store.updateAssistant(accepted.run.id, started.attemptId, text);
    });
    await store.finishRun(accepted.run.id, started.attemptId, 'completed', text);
    return text;
  };
  assert.equal(await turn('/remember demo-user-value'), 'Value remembered for this conversation.');
  assert.equal(await turn('/context'), 'demo-user-value');
  const saved = await store.snapshot(demoId('release'), 100);
  assert.equal(saved.messages.length, 10);
  assert.equal(saved.activeRun, null);
  assert.equal(saved.messages.at(-1)!.content, 'demo-user-value');
  assert.equal((await store.listConversations(100)).conversations[0]!.id, demoId('release'));
});

test('re-import preserves user edits, subsequent messages, archives and unrelated conversations', async (t) => {
  const { pool, config, store } = await fixture(t);
  await seedDemo(pool, config);
  const unrelated = await store.createConversation('My own conversation');
  await store.patchConversation(demoId('release'), { title: 'My edited demo', archived: true });
  const accepted = await store.acceptMessage(demoId('empty'), 'My own added message', randomUUID(), true);
  const started = await store.startRun(accepted.run.id);
  await store.finishRun(accepted.run.id, started!.attemptId, 'completed', 'My own saved answer');
  const before = await pool.query('SELECT id, title, archived_at, updated_at FROM conversations ORDER BY id');
  const saved = await store.snapshot(demoId('empty'), 100);
  assert.deepEqual(await seedDemo(pool, config), { created: 0, skipped: 7 });
  assert.deepEqual((await pool.query('SELECT id, title, archived_at, updated_at FROM conversations ORDER BY id')).rows, before.rows);
  assert.deepEqual(await store.snapshot(demoId('empty'), 100), saved);
  assert.ok((await store.listConversations(100)).conversations.some(chat => chat.id === unrelated.id));
});

test('seeded event replay reconstructs exact canonical messages including partial failures and cancellation', async (t) => {
  const { pool, config, store } = await fixture(t);
  await seedDemo(pool, config);
  const canonical = await store.snapshot(demoId('recovery'), 100);
  const events = await store.events(demoId('recovery'), 0);
  assert.deepEqual(events.map(event => event.sequence), Array.from({ length: 16 }, (_, index) => index + 1));
  const replay = new Map<string, Message>();
  for (const event of events) {
    for (const message of [event.payload.userMessage, event.payload.assistantMessage, event.payload.message]) {
      if (message) replay.set(message.id, message);
    }
  }
  assert.deepEqual([...replay.values()].sort((a, b) => a.order - b.order), canonical.messages);
  assert.deepEqual(canonical.messages.filter(message => message.role === 'assistant').map(message => message.status), ['failed', 'completed', 'cancelled', 'interrupted']);
  assert.ok(canonical.messages.at(-1)!.content.endsWith(' '));
  assert.equal(canonical.cursor, events.at(-1)!.sequence);
});

test('concurrent demo imports serialize and a conflicting owner rolls back the whole batch', async (t) => {
  const { pool, config } = await fixture(t);
  await pool.query('INSERT INTO conversations (id, owner_id, title) VALUES ($1, $2, $3)', [demoId('code'), 'another-owner', 'Private conversation']);
  await assert.rejects(seedDemo(pool, config), /different owner/);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM conversations')).rows[0].count, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM messages')).rows[0].count, 0);
  await pool.query('DELETE FROM conversations WHERE id = $1', [demoId('code')]);
  const results = await Promise.all([seedDemo(pool, config), seedDemo(pool, config)]);
  assert.equal(results.reduce((sum, result) => sum + result.created, 0), demoConversations.length);
  assert.equal(results.reduce((sum, result) => sum + result.skipped, 0), demoConversations.length);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM conversations')).rows[0].count, 7);
});

test('demo data rejects Pi mode and remote or malformed database targets before import', () => {
  assert.throws(() => assertDemoConfiguration({ agentMode: 'pi', databaseUrl }), /mock mode/);
  for (const target of [
    'postgres://user@db.example.com/nexrun', 'not-a-url', 'postgres://127.0.0.1.example.com/nexrun',
    'postgres://localhost/nexrun?host=db.example.com', 'postgres://localhost/nexrun?h%6fst=db.example.com',
    'postgres://localhost/nexrun?hostaddr=203.0.113.1', 'https://localhost/nexrun',
  ]) {
    assert.throws(() => assertDemoConfiguration({ agentMode: 'mock', databaseUrl: target }), /loopback/);
  }
  for (const target of ['postgres://127.0.0.1/nexrun', 'postgres://localhost/nexrun', 'postgres://[::1]/nexrun', 'postgresql://localhost/nexrun?sslmode=disable&application_name=nexrun-demo']) {
    assert.doesNotThrow(() => assertDemoConfiguration({ agentMode: 'mock', databaseUrl: target }));
  }
});
