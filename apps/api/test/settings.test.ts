import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import type { AdminSettingsUpdate } from '@nexrun/protocol';
import { loadConfig, type ApiConfig } from '../src/config.js';
import { migrate, transaction, TransactionCommitUnknownError } from '../src/db.js';
import { adminAccess, authorizeAdmin, checkOpenAiCredential, SettingsStore, type AdminRequest, type EffectiveSettings } from '../src/settings.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://nexrun:nexrun@127.0.0.1:55439/nexrun';
const environmentKey = 'environment-test-placeholder-key';
const storedKey = 'stored-test-placeholder-private-key';

async function fixture(t: TestContext, options: { environment?: NodeJS.ProcessEnv; encryptionKey?: string; initialize?: boolean } = {}) {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `settings_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
  const stateDir = await mkdtemp(join(tmpdir(), 'nexrun-settings-test-'));
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(stateDir, { recursive: true, force: true });
  });
  await migrate(pool);
  const config: ApiConfig = { ...loadConfig({}), stateDir, ...(options.encryptionKey ? { encryptionKey: options.encryptionKey } : {}) };
  const environment = options.environment ?? { NEXRUN_OPENAI_API_KEY: environmentKey, OPENAI_API_KEY: 'generic-test-placeholder-key' };
  const store = new SettingsStore(pool, config, { environment });
  if (options.initialize !== false) await store.initialize();
  return { pool, config, environment, store, stateDir };
}

function update(store: SettingsStore, changes: Partial<AdminSettingsUpdate> = {}): AdminSettingsUpdate {
  const current = store.getEffective();
  return { revision: current.revision, adapter: current.adapter, provider: current.provider, model: current.model, responseLanguage: current.responseLanguage, keyAction: 'keep', ...changes };
}

test('settings migrations apply both versions, including upgrading an existing version-one database', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.pool.query('SELECT version FROM nexrun_migrations ORDER BY version')).rows.map((row) => row.version), [1, 2]);
  await f.pool.query('DROP TABLE admin_settings; ALTER TABLE agent_sessions DROP COLUMN model, DROP COLUMN provider; DELETE FROM nexrun_migrations WHERE version = 2');
  await migrate(f.pool);
  await migrate(f.pool);
  assert.deepEqual((await f.pool.query('SELECT version FROM nexrun_migrations ORDER BY version')).rows.map((row) => row.version), [1, 2]);
  const columns = await f.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agent_sessions'");
  assert.ok(columns.rows.some((row) => row.column_name === 'model'));
  assert.ok(columns.rows.some((row) => row.column_name === 'provider'));
});

test('settings default to server configuration and expose only sanitized catalog and credential metadata', async (t) => {
  const f = await fixture(t);
  const current = f.store.getEffective();
  assert.equal(current.apiKey, environmentKey);
  assert.equal(current.responseLanguage, 'auto');
  const snapshot = await f.store.getPublic(2);
  assert.equal(snapshot.activeRuns, 2);
  assert.equal(snapshot.keySource, 'environment');
  assert.equal(snapshot.environmentKeyAvailable, true);
  assert.equal(snapshot.keyConfigured, true);
  assert.ok(snapshot.models.some((model) => model.id === 'gpt-5-mini'));
  assert.ok(snapshot.models.every((model) => Object.keys(model).sort().join(',') === 'id,name'));
  assert.ok(!JSON.stringify(snapshot).includes(environmentKey));
  assert.ok(!Object.hasOwn(snapshot, 'apiKey'));
  assert.ok(!Object.hasOwn(snapshot, 'encrypted_api_key'));
});

test('stored credentials are authenticated ciphertext, survive restart, and use private master-key permissions', async (t) => {
  const f = await fixture(t);
  const proposed = await f.store.prepareUpdate(update(f.store, { adapter: 'pi', responseLanguage: 'zh-CN', keyAction: 'replace', apiKey: storedKey }));
  assert.equal(f.store.preview(proposed).apiKey, storedKey);
  assert.equal(f.store.getEffective().apiKey, environmentKey, 'Preview must not mutate runtime settings.');
  await f.store.update(proposed);
  const row = (await f.pool.query('SELECT * FROM admin_settings')).rows[0];
  assert.equal(row.key_mode, 'stored');
  assert.ok(row.encrypted_api_key.startsWith('v1:'));
  assert.ok(!JSON.stringify(row).includes(storedKey));
  const keyPath = join(f.stateDir, 'configuration', 'encryption.key');
  assert.equal((await stat(join(f.stateDir, 'configuration'))).mode & 0o777, 0o700);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(keyPath)).length, 32);
  assert.ok(!(await readFile(keyPath)).includes(Buffer.from(storedKey)));
  const restarted = new SettingsStore(f.pool, f.config, { environment: {} });
  await restarted.initialize();
  assert.equal(restarted.getEffective().apiKey, storedKey);
  assert.equal(restarted.getEffective().responseLanguage, 'zh-CN');
  assert.equal((await restarted.getPublic(0)).keySource, 'stored');
  assert.ok(!JSON.stringify(await restarted.getPublic(0)).includes(storedKey));
});

test('keep, remove, and inherit explicitly preserve, disable, and reenable environment fallback', async (t) => {
  const f = await fixture(t);
  await f.store.update(update(f.store, { keyAction: 'replace', apiKey: storedKey }));
  const encrypted = (await f.pool.query('SELECT encrypted_api_key FROM admin_settings')).rows[0].encrypted_api_key;
  await f.store.update(update(f.store, { keyAction: 'keep', responseLanguage: 'en' }));
  assert.equal((await f.pool.query('SELECT encrypted_api_key FROM admin_settings')).rows[0].encrypted_api_key, encrypted);
  await f.store.update(update(f.store, { keyAction: 'remove' }));
  assert.equal(f.store.getEffective().apiKey, undefined);
  assert.equal((await f.store.getPublic(0)).keySource, 'none');
  assert.equal((await f.store.getPublic(0)).environmentKeyAvailable, true);
  const restarted = new SettingsStore(f.pool, f.config, { environment: f.environment });
  await restarted.initialize();
  assert.equal(restarted.getEffective().apiKey, undefined, 'Removing a key must persistently disable env fallback.');
  await restarted.update(update(restarted, { keyAction: 'inherit' }));
  assert.equal(restarted.getEffective().apiKey, environmentKey);
  assert.equal((await restarted.getPublic(0)).keySource, 'environment');
  assert.equal((await f.pool.query('SELECT encrypted_api_key FROM admin_settings')).rows[0].encrypted_api_key, null);
});

test('tampered ciphertext and a mismatched encryption key fail closed without returning secrets', async (t) => {
  const f = await fixture(t);
  await f.store.update(update(f.store, { keyAction: 'replace', apiKey: storedKey }));
  const wrongKey = new SettingsStore(f.pool, { ...f.config, encryptionKey: randomBytes(32).toString('base64') }, { environment: {} });
  await assert.rejects(wrongKey.initialize(), { code: 'CONFIGURATION_ERROR', message: 'CONFIGURATION_ERROR' });
  await f.pool.query("UPDATE admin_settings SET encrypted_api_key = encrypted_api_key || 'tampered'");
  const restarted = new SettingsStore(f.pool, f.config, { environment: {} });
  await assert.rejects(restarted.initialize(), { code: 'CONFIGURATION_ERROR', message: 'CONFIGURATION_ERROR' });
  assert.throws(() => restarted.getEffective(), { code: 'CONFIGURATION_ERROR' });
});

test('external base64 master keys support restart without creating a secret file', async (t) => {
  const f = await fixture(t, { encryptionKey: randomBytes(32).toString('base64'), environment: {} });
  assert.equal((await f.store.getPublic(0)).keySource, 'none');
  await f.store.update(update(f.store, { keyAction: 'replace', apiKey: storedKey }));
  await assert.rejects(stat(join(f.stateDir, 'configuration', 'encryption.key')), { code: 'ENOENT' });
  const restarted = new SettingsStore(f.pool, f.config, { environment: {} });
  await restarted.initialize();
  assert.equal(restarted.getEffective().apiKey, storedKey);
  const invalid = new SettingsStore(f.pool, { ...f.config, encryptionKey: 'not-a-valid-base64-master-key' });
  await assert.rejects(invalid.initialize(), { code: 'CONFIGURATION_ERROR' });
});

test('settings CAS rejects stale updates and failed persistence leaves effective runtime unchanged', async (t) => {
  const f = await fixture(t);
  const stale = new SettingsStore(f.pool, f.config, { environment: f.environment });
  await stale.initialize();
  await f.store.update(update(f.store, { responseLanguage: 'en' }));
  await assert.rejects(stale.update(update(stale, { responseLanguage: 'zh-CN' })), { code: 'SETTINGS_CONFLICT', statusCode: 409 });
  assert.equal(stale.getEffective().revision, 0);
  assert.equal(stale.getEffective().responseLanguage, 'auto');
  const previous = f.store.getEffective();
  await f.pool.query("CREATE FUNCTION reject_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected settings persistence failure'; END $$; CREATE TRIGGER reject_settings BEFORE UPDATE ON admin_settings FOR EACH ROW EXECUTE FUNCTION reject_settings()");
  await assert.rejects(f.store.update(update(f.store, { keyAction: 'replace', apiKey: storedKey })), { code: 'CONFIGURATION_ERROR', message: 'CONFIGURATION_ERROR' });
  assert.deepEqual(f.store.getEffective(), previous);
});

test('settings reject unknown fields, unsupported catalog values, and unsafe credential input', async (t) => {
  const f = await fixture(t);
  const cases: unknown[] = [null, [], {}, { ...update(f.store), extra: true },
    update(f.store, { revision: -1 }), update(f.store, { revision: 0.5 }),
    { ...update(f.store), adapter: 'other' }, { ...update(f.store), provider: 'https://other.invalid' },
    update(f.store, { model: 'not-in-the-installed-catalog' }), { ...update(f.store), responseLanguage: 'zh' },
    { ...update(f.store), keyAction: {} }, { ...update(f.store), apiKey: storedKey },
    update(f.store, { keyAction: 'replace', apiKey: 'short' }),
    update(f.store, { keyAction: 'replace', apiKey: 'contains whitespace secret' }),
    update(f.store, { keyAction: 'replace', apiKey: 'control-character-\n-key' }),
    update(f.store, { keyAction: 'replace', apiKey: 'trailing-control-key\n' }),
    update(f.store, { keyAction: 'replace', apiKey: 'x'.repeat(4097) }),
  ];
  for (const value of cases) await assert.rejects(f.store.prepareUpdate(value), { code: 'VALIDATION_ERROR' });
  assert.equal(f.store.getEffective().revision, 0);
});

function request(changes: Partial<AdminRequest> = {}): AdminRequest {
  return { ip: '127.0.0.1', method: 'GET', headers: { host: '127.0.0.1:3001' }, ...changes };
}

test('local admin fallback requires direct loopback access and explicit local mutation origins', () => {
  const config = loadConfig({});
  assert.deepEqual(adminAccess(request(), config), { requiresToken: false, localAccess: true });
  assert.doesNotThrow(() => authorizeAdmin(request({ method: 'PATCH', headers: { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173' } }), config));
  assert.doesNotThrow(() => authorizeAdmin(request({ ip: '::ffff:127.0.0.1' }), config));
  assert.doesNotThrow(() => authorizeAdmin(request({ ip: undefined, raw: { socket: { remoteAddress: '127.0.0.1' } } }), config));
  const denied = [
    request({ ip: '192.0.2.1' }), request({ headers: { host: 'external.invalid:3001' } }),
    request({ method: 'POST' }), request({ headers: { host: '127.0.0.1:3001', origin: 'https://external.invalid' } }),
    request({ headers: { host: '127.0.0.1:3001', 'x-forwarded-for': '127.0.0.1' } }),
    request({ headers: { host: '127.0.0.1:3001', forwarded: 'for=127.0.0.1' } }),
    request({ headers: { host: '127.0.0.1:3001', origin: ['http://127.0.0.1:5173'] } }),
  ];
  for (const value of denied) assert.throws(() => authorizeAdmin(value, config), { code: 'ADMIN_ACCESS_DENIED', statusCode: 403 });
});

test('configured admin tokens are mandatory even on loopback and never appear in access metadata', () => {
  const token = 'admin-test-placeholder-token';
  const config = { ...loadConfig({}), adminToken: token };
  assert.deepEqual(adminAccess(request(), config), { requiresToken: true, localAccess: true });
  assert.throws(() => authorizeAdmin(request(), config), { code: 'ADMIN_AUTH_REQUIRED', statusCode: 401 });
  assert.throws(() => authorizeAdmin(request({ headers: { host: '127.0.0.1:3001', authorization: 'Bearer incorrect' } }), config), { code: 'ADMIN_AUTH_REQUIRED' });
  assert.throws(() => authorizeAdmin(request({ headers: { host: '127.0.0.1:3001', authorization: `Bearer ${token}\n` } }), config), { code: 'ADMIN_AUTH_REQUIRED' });
  const access = authorizeAdmin(request({ ip: '192.0.2.1', headers: { host: 'external.invalid', authorization: `Bearer ${token}` } }), config);
  assert.deepEqual(access, { requiresToken: true, localAccess: false });
  assert.ok(!JSON.stringify(access).includes(token));
});

test('credential checks use one fixed URL, never redirect, and return only stable diagnostics', async () => {
  const settings: EffectiveSettings = { revision: 7, adapter: 'pi', provider: 'openai', model: 'gpt-5-mini', responseLanguage: 'auto', apiKey: storedKey };
  let requests = 0;
  const ok = await checkOpenAiCredential(settings, async (url, options) => {
    requests += 1;
    assert.equal(url, 'https://api.openai.com/v1/models/gpt-5-mini');
    assert.equal(options!.method, 'GET');
    assert.equal(options!.redirect, 'error');
    assert.equal(new Headers(options!.headers).get('authorization'), `Bearer ${storedKey}`);
    assert.ok(options!.signal instanceof AbortSignal);
    return Response.json({ id: settings.model, private: storedKey });
  });
  assert.equal(requests, 1);
  assert.equal(ok.code, 'CONNECTION_OK');
  assert.equal(ok.revision, 7);
  assert.equal(ok.ok, true);
  assert.ok(!JSON.stringify(ok).includes(storedKey));
  const missing = await checkOpenAiCredential({ ...settings, apiKey: undefined }, async () => { throw new Error('Must not call the network.'); });
  assert.equal(missing.code, 'AGENT_NOT_CONFIGURED');
  const statuses = [[401, 'UPSTREAM_AUTHENTICATION_FAILED'], [403, 'UPSTREAM_AUTHENTICATION_FAILED'], [429, 'UPSTREAM_RATE_LIMITED'], [404, 'MODEL_UNAVAILABLE'], [400, 'MODEL_UNAVAILABLE'], [500, 'UPSTREAM_ERROR']] as const;
  for (const [status, code] of statuses) {
    const result = await checkOpenAiCredential(settings, async () => Response.json({ error: { message: storedKey } }, { status }));
    assert.equal(result.code, code);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(storedKey));
  }
  assert.equal((await checkOpenAiCredential(settings, async () => { throw new Error(`PRIVATE_NETWORK_ERROR ${storedKey}`); })).code, 'NETWORK_ERROR');
  assert.equal((await checkOpenAiCredential(settings, async () => Response.json({ id: 'wrong-model' }))).code, 'UPSTREAM_ERROR');
  assert.equal((await checkOpenAiCredential(settings, async () => new Response('not JSON'))).code, 'UPSTREAM_ERROR');
});

test('server configuration keeps admin encryption and response language independent of UI locale', () => {
  const key = randomBytes(32).toString('base64');
  const config = loadConfig({ NEXRUN_ADMIN_TOKEN: 'admin-test-token', NEXRUN_CONFIG_ENCRYPTION_KEY: key, AGENT_RESPONSE_LANGUAGE: 'zh-CN' });
  assert.equal(config.adminToken, 'admin-test-token');
  assert.equal(config.encryptionKey, key);
  assert.equal(config.responseLanguage, 'zh-CN');
  assert.equal(loadConfig({}).responseLanguage, 'auto');
  assert.throws(() => loadConfig({ AGENT_RESPONSE_LANGUAGE: 'invalid' }), /Invalid AGENT_RESPONSE_LANGUAGE/);
});


test('environment defaults refresh unsaved revision-zero settings while explicit saved settings survive restart', async (t) => {
  const f = await fixture(t);
  const alternate = (await f.store.getPublic(0)).models.find((model) => model.id !== 'gpt-5-mini')!.id;
  const changedDefaults: ApiConfig = { ...f.config, agentMode: 'pi', model: alternate, responseLanguage: 'zh-CN' };
  const unsavedRestart = new SettingsStore(f.pool, changedDefaults, { environment: f.environment });
  await unsavedRestart.initialize();
  assert.equal(unsavedRestart.getEffective().revision, 0);
  assert.equal(unsavedRestart.getEffective().adapter, 'pi');
  assert.equal(unsavedRestart.getEffective().model, alternate);
  assert.equal(unsavedRestart.getEffective().responseLanguage, 'zh-CN');
  await unsavedRestart.update(update(unsavedRestart, { adapter: 'mock', model: 'gpt-5-mini', responseLanguage: 'en' }));
  const savedRestart = new SettingsStore(f.pool, changedDefaults, { environment: f.environment });
  await savedRestart.initialize();
  assert.equal(savedRestart.getEffective().revision, 1);
  assert.equal(savedRestart.getEffective().adapter, 'mock');
  assert.equal(savedRestart.getEffective().model, 'gpt-5-mini');
  assert.equal(savedRestart.getEffective().responseLanguage, 'en');

  await f.pool.query("UPDATE admin_settings SET model = 'model-from-a-previous-sdk-catalog' WHERE revision = 1");
  const unavailableModel = new SettingsStore(f.pool, changedDefaults, { environment: f.environment });
  await unavailableModel.initialize();
  assert.equal(unavailableModel.getEffective().model, 'model-from-a-previous-sdk-catalog');
  assert.ok(!(await unavailableModel.getPublic(0)).models.some((model) => model.id === unavailableModel.getEffective().model));
});


test('a lost COMMIT acknowledgement invalidates cached settings even when PostgreSQL saved the new revision', async (t) => {
  const f = await fixture(t);
  const client = await f.pool.connect();
  const execute = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  const release = client.release.bind(client);
  let discarded = false;
  t.mock.method(client, 'release', (error?: Error | boolean) => { discarded = error === true; release(error); });
  t.mock.method(client, 'query', async (...args: unknown[]) => {
    const result = await execute(...args);
    if (args[0] === 'COMMIT') throw Object.assign(new Error('PRIVATE_COMMIT_ACK_FAILURE'), { code: 'ECONNRESET' });
    return result;
  });
  const interruptedPool = { query: f.pool.query.bind(f.pool), connect: async () => client } as unknown as Pool;
  const uncertain = new SettingsStore(interruptedPool, f.config, { environment: f.environment });
  await uncertain.initialize();
  const changed = update(uncertain, { adapter: 'pi', keyAction: 'remove', responseLanguage: 'zh-CN' });
  await assert.rejects(uncertain.update(changed), { code: 'SETTINGS_COMMIT_UNKNOWN', statusCode: 503, message: 'SETTINGS_COMMIT_UNKNOWN' });
  assert.equal(discarded, true);
  const persisted = (await f.pool.query('SELECT revision, adapter, key_mode FROM admin_settings')).rows[0];
  assert.deepEqual(persisted, { revision: 1, adapter: 'pi', key_mode: 'disabled' });
  assert.throws(() => uncertain.getEffective(), { code: 'SETTINGS_COMMIT_UNKNOWN', statusCode: 503 });
  await assert.rejects(uncertain.getPublic(0), { code: 'SETTINGS_COMMIT_UNKNOWN' });
  assert.throws(() => uncertain.preview(changed), { code: 'SETTINGS_COMMIT_UNKNOWN' });
  await assert.rejects(uncertain.prepareUpdate(changed), { code: 'SETTINGS_COMMIT_UNKNOWN' });
  await assert.rejects(uncertain.update(changed), { code: 'SETTINGS_COMMIT_UNKNOWN' });
  const recovered = new SettingsStore(f.pool, f.config, { environment: f.environment });
  await recovered.initialize();
  assert.equal(recovered.getEffective().revision, 1);
  assert.equal(recovered.getEffective().adapter, 'pi');
  assert.equal(recovered.getEffective().apiKey, undefined);
  assert.equal(recovered.getEffective().responseLanguage, 'zh-CN');
});

test('a rollback failure preserves the original operation error and discards the connection', async () => {
  for (const original of [new Error('Original operation failure'), new TransactionCommitUnknownError()]) {
    let discarded = false;
    const client = {
      async query(sql: string) { if (sql === 'ROLLBACK') throw new Error('Rollback transport failure'); },
      release(error?: boolean) { discarded = error === true; },
    };
    const pool = { connect: async () => client } as unknown as Pool;
    await assert.rejects(transaction(pool, async () => { throw original; }), error => error === original);
    assert.equal(discarded, true);
  }
});

test('unknown commit errors remain sanitized when rollback also fails', async () => {
  let discarded = false;
  const client = {
    async query(sql: string) { if (sql !== 'BEGIN') throw new Error('PRIVATE_DATABASE_OR_TRANSPORT_DETAIL'); },
    release(error?: boolean) { discarded = error === true; },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(transaction(pool, async () => 'result'), error => {
    assert.ok(error instanceof TransactionCommitUnknownError);
    assert.equal(error.message, 'TRANSACTION_COMMIT_UNKNOWN');
    assert.equal(error.code, 'TRANSACTION_COMMIT_UNKNOWN');
    assert.ok(!JSON.stringify(error).includes('PRIVATE_'));
    return true;
  });
  assert.equal(discarded, true);
});
