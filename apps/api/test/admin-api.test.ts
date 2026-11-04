import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { AdminSettings, AdminSettingsUpdate, AcceptedMessage, Conversation, Run, RuntimeConfig } from '@nexrun/protocol';
import { buildApp, type BuildAppOptions } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMockAdapter } from '../src/agents/mock.js';
import type { AgentAdapter } from '../src/agents/types.js';
import type { EffectiveSettings } from '../src/settings.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://nexrun:nexrun@127.0.0.1:55439/nexrun';
const headers = { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173' };

async function fixture(t: TestContext, extras: Partial<BuildAppOptions> = {}) {
  const schema = `nexrun_admin_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
  const stateDir = await mkdtemp(join(tmpdir(), 'nexrun-admin-api-'));
  const invocations: EffectiveSettings[] = [];
  const options: BuildAppOptions = {
    pool, config: { ...loadConfig({}), stateDir }, settingsEnvironment: { OPENAI_API_KEY: 'environment-placeholder-not-a-real-key' },
    adapterFactory(effective): AgentAdapter {
      invocations.push({ ...effective });
      if (effective.adapter === 'mock') return createMockAdapter({ responseLanguage: effective.responseLanguage });
      return {
        mode: 'pi', configured: Boolean(effective.apiKey), model: effective.model,
        async generate(_input, onText) { await onText('Synthetic Pi reply.'); },
      };
    },
    settingsChecker: async effective => ({ ok: true, code: 'CONNECTION_OK', revision: effective.revision, checkedAt: new Date().toISOString() }),
    ...extras,
  };
  const result = {
    app: undefined as unknown as FastifyInstance, pool, options, invocations,
    request: (input: InjectOptions) => result.app.inject({ ...input, headers: { ...headers, ...input.headers } }),
  };
  t.after(async () => {
    await result.app?.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(stateDir, { recursive: true, force: true });
  });
  result.app = await buildApp(options);
  return result;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function settings(f: Fixture): Promise<AdminSettings> {
  const response = await f.request({ method: 'GET', url: '/api/admin/settings' });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function save(f: Fixture, current: AdminSettings, change: Partial<AdminSettingsUpdate> = {}) {
  return f.request({ method: 'PATCH', url: '/api/admin/settings', payload: {
    revision: current.revision, adapter: current.adapter, provider: current.provider, model: current.model,
    responseLanguage: current.responseLanguage, keyAction: 'keep', ...change,
  } });
}
async function chat(f: Fixture): Promise<Conversation> {
  const response = await f.request({ method: 'POST', url: '/api/conversations', payload: {} });
  assert.equal(response.statusCode, 201);
  return response.json();
}
async function send(f: Fixture, id: string, content: string) {
  return f.request({ method: 'POST', url: `/api/conversations/${id}/messages`, headers: { 'idempotency-key': randomUUID() }, payload: { content } });
}
async function terminal(f: Fixture, id: string): Promise<Run> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = (await f.request({ method: 'GET', url: `/api/runs/${id}` })).json<Run>();
    if (!['queued', 'running', 'cancelling'].includes(run.status)) return run;
    await delay(10);
  }
  throw new Error('The test Run did not settle.');
}

test('admin saves an encrypted credential, applies it immediately, and restores it after API restart without returning it', async t => {
  const f = await fixture(t);
  const initial = await settings(f);
  const secret = 'stored-secret-placeholder-never-return-this';
  const updated = await save(f, initial, { adapter: 'pi', keyAction: 'replace', apiKey: secret, responseLanguage: 'en' });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.ok(!updated.body.includes(secret));
  const saved = updated.json<AdminSettings>();
  assert.equal(saved.keySource, 'stored');
  assert.equal(saved.revision, initial.revision + 1);
  assert.equal(f.invocations.at(-1)!.apiKey, secret);
  assert.deepEqual((await f.request({ method: 'GET', url: '/api/config' })).json<RuntimeConfig>(), { adapter: 'pi', configured: true, model: saved.model, responseLanguage: 'en' });
  const row = (await f.pool.query('SELECT * FROM admin_settings')).rows[0];
  assert.ok(row.encrypted_api_key.startsWith('v1:'));
  assert.ok(!JSON.stringify(row).includes(secret));
  const read = await f.request({ method: 'GET', url: '/api/admin/settings' });
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.ok(!read.body.includes(secret) && !read.body.includes('encrypted_api_key'));
  await f.app.close();
  f.app = await buildApp(f.options);
  assert.equal((await settings(f)).keySource, 'stored');
  assert.equal((await settings(f)).adapter, 'pi');
  assert.equal(f.invocations.at(-1)!.apiKey, secret);
});

test('credential rotation keeps a Pi chat usable while changing its model requires a new conversation', async t => {
  const f = await fixture(t);
  let current = await settings(f);
  current = (await save(f, current, { adapter: 'pi', keyAction: 'replace', apiKey: 'first-placeholder-stored-key' })).json();
  const conversation = await chat(f);
  const first = (await send(f, conversation.id, 'First message')).json<AcceptedMessage>();
  assert.equal((await terminal(f, first.run.id)).status, 'completed');
  await delay(20);
  current = (await save(f, current, { keyAction: 'replace', apiKey: 'rotated-placeholder-stored-key' })).json();
  const repeated = await send(f, conversation.id, 'After credential rotation');
  assert.equal(repeated.statusCode, 202, repeated.body);
  await terminal(f, repeated.json<AcceptedMessage>().run.id);
  await delay(20);
  const otherModel = current.models.find(model => model.id !== current.model)!;
  const changed = await save(f, current, { model: otherModel.id });
  assert.equal(changed.statusCode, 200, changed.body);
  const incompatible = await send(f, conversation.id, 'Do not silently change my model');
  assert.equal(incompatible.statusCode, 409);
  assert.equal(incompatible.json().error.code, 'AGENT_SESSION_MISMATCH');
  const fresh = await chat(f);
  const accepted = await send(f, fresh.id, 'A fresh model conversation');
  assert.equal(accepted.statusCode, 202);
  await terminal(f, accepted.json<AcceptedMessage>().run.id);
  // Migration 002 leaves legacy model bindings unknown; never infer them from current settings.
  await f.pool.query('UPDATE agent_sessions SET provider = NULL, model = NULL WHERE conversation_id = $1', [fresh.id]);
  const legacy = await send(f, fresh.id, 'Do not guess a legacy model binding');
  assert.equal(legacy.statusCode, 409);
  assert.equal(legacy.json().error.code, 'AGENT_SESSION_MISMATCH');
  const history = await f.request({ method: 'GET', url: `/api/conversations/${fresh.id}/messages` });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().messages.length, 2);
});

test('settings cannot change while a server-owned Run is active and admission uses the saved language afterward', async t => {
  const f = await fixture(t);
  const current = await settings(f);
  const conversation = await chat(f);
  const accepted = (await send(f, conversation.id, '/slow')).json<AcceptedMessage>();
  const blocked = await save(f, current, { responseLanguage: 'zh-CN' });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, 'SETTINGS_BUSY');
  assert.equal((await settings(f)).revision, current.revision);
  assert.ok((await settings(f)).activeRuns > 0);
  await f.request({ method: 'POST', url: `/api/runs/${accepted.run.id}/cancel`, payload: {} });
  await terminal(f, accepted.run.id);
  await delay(20);
  const changed = await save(f, current, { responseLanguage: 'zh-CN' });
  assert.equal(changed.statusCode, 200, changed.body);
  const fresh = await chat(f);
  const next = (await send(f, fresh.id, 'An English prompt')).json<AcceptedMessage>();
  await terminal(f, next.run.id);
  const snapshot = (await f.request({ method: 'GET', url: `/api/conversations/${fresh.id}/messages` })).json();
  assert.match(snapshot.messages.at(-1).content, /\p{Script=Han}/u);
  assert.equal(snapshot.messages[0].content, 'An English prompt');
});

test('a failed configuration commit leaves runtime, revision and plaintext exposure unchanged', async t => {
  const f = await fixture(t);
  const current = await settings(f);
  await f.pool.query("CREATE FUNCTION reject_settings_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database details must never be returned'; END $$");
  await f.pool.query('CREATE TRIGGER reject_settings BEFORE UPDATE ON admin_settings FOR EACH ROW EXECUTE FUNCTION reject_settings_write()');
  const failed = await save(f, current, { adapter: 'pi', keyAction: 'replace', apiKey: 'failed-placeholder-secret-key' });
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().error.code, 'CONFIGURATION_ERROR');
  assert.ok(!failed.body.includes('private database details') && !failed.body.includes('failed-placeholder-secret-key'));
  assert.equal((await settings(f)).revision, current.revision);
  assert.equal((await f.request({ method: 'GET', url: '/api/config' })).json<RuntimeConfig>().adapter, 'mock');
});

test('admin mutations enforce local-origin access and configured tokens, without protecting only the page', async t => {
  const f = await fixture(t);
  const current = await settings(f);
  const denied = await f.app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { host: headers.host }, payload: { ...current } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'ADMIN_ACCESS_DENIED');
  const forwarded = await f.request({ method: 'GET', url: '/api/admin/settings', headers: { 'x-forwarded-for': '127.0.0.1' } });
  assert.equal(forwarded.statusCode, 403);
  const token = 'private-admin-token-placeholder-for-api-test';
  await f.app.close();
  f.app = await buildApp({ ...f.options, config: { ...f.options.config, adminToken: token } });
  const access = await f.request({ method: 'GET', url: '/api/admin/access' });
  assert.equal(access.json().requiresToken, true);
  assert.ok(!access.body.includes(token));
  const locked = await f.request({ method: 'GET', url: '/api/admin/settings' });
  assert.equal(locked.statusCode, 401);
  const wrong = await f.request({ method: 'GET', url: '/api/admin/settings', headers: { authorization: 'Bearer incorrect-placeholder' } });
  assert.equal(wrong.statusCode, 401);
  const unlocked = await f.request({ method: 'GET', url: '/api/admin/settings', headers: { authorization: `Bearer ${token}` } });
  assert.equal(unlocked.statusCode, 200);
  assert.ok(!unlocked.body.includes(token));
});

test('connection checks use the persisted revision and sanitize unexpected checker failures', async t => {
  const f = await fixture(t, { settingsChecker: async effective => { throw new Error(`private provider response: ${effective.apiKey}`); } });
  const current = await settings(f);
  const stale = await f.request({ method: 'POST', url: '/api/admin/connection-check', payload: { revision: current.revision + 1 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'SETTINGS_CONFLICT');
  const checked = await f.request({ method: 'POST', url: '/api/admin/connection-check', payload: { revision: current.revision } });
  assert.equal(checked.statusCode, 200);
  assert.equal(checked.json().code, 'NETWORK_ERROR');
  assert.ok(!checked.body.includes('private provider response') && !checked.body.includes('environment-placeholder'));
});


test('an unknown settings commit rejects queued admission and closes instead of using the old runtime', async t => {
  const f = await fixture(t);
  const current = await settings(f);
  const conversation = await chat(f);
  const connect = f.pool.connect.bind(f.pool) as (callback?: unknown) => Promise<PoolClient> | void;
  let reachedCommit!: () => void;
  let loseAcknowledgement!: () => void;
  const committed = new Promise<void>(resolve => { reachedCommit = resolve; });
  const releaseFailure = new Promise<void>(resolve => { loseAcknowledgement = resolve; });
  let injected = false;
  t.mock.method(f.pool, 'connect', ((callback?: unknown) => {
    if (callback !== undefined) return connect(callback);
    return (connect() as Promise<PoolClient>).then(client => {
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      let settingsWrite = false;
      t.mock.method(client, 'query', async (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('UPDATE admin_settings SET')) settingsWrite = true;
        const result = await query(...args);
        if (args[0] === 'COMMIT' && settingsWrite && !injected) {
          injected = true;
          reachedCommit();
          await releaseFailure;
          throw Object.assign(new Error('PRIVATE_SETTINGS_COMMIT_ACK_FAILURE'), { code: 'ECONNRESET' });
        }
        return result;
      });
      return client;
    });
  }) as Pool['connect']);
  const saving = save(f, current, { adapter: 'pi', keyAction: 'remove' });
  await committed;
  const queuedMessage = send(f, conversation.id, 'Must not use the previous configured runtime');
  // Allow the request to enter the shared gate before losing the commit acknowledgement.
  await delay(10);
  loseAcknowledgement();
  const failed = await saving;
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(failed.json().error.code, 'SETTINGS_COMMIT_UNKNOWN');
  assert.ok(!failed.body.includes('PRIVATE_SETTINGS_COMMIT_ACK_FAILURE'));
  const denied = await queuedMessage;
  assert.equal(denied.statusCode, 503, denied.body);
  const counts = (await f.pool.query('SELECT (SELECT count(*) FROM runs)::int AS runs, (SELECT count(*) FROM messages)::int AS messages')).rows[0];
  assert.deepEqual(counts, { runs: 0, messages: 0 });
  assert.equal((await f.pool.query('SELECT revision FROM admin_settings')).rows[0].revision, current.revision + 1);
  await f.app.close();
  f.app = await buildApp(f.options);
  const recovered = await settings(f);
  assert.equal(recovered.revision, current.revision + 1);
  assert.equal(recovered.adapter, 'pi');
  assert.equal(recovered.keyConfigured, false);
});
