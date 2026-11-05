import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMockAdapter } from '../src/agents/mock.js';

// The generated identifier never includes an environment variable or user input.
const schema = `nexrun_e2e_${process.pid}_${randomBytes(8).toString('hex')}`;
let adminPool: Pool | undefined;
let pool: Pool | undefined;
let app: FastifyInstance | undefined;
let stateDir: string | undefined;
let schemaCreated = false;
let stopping = false;
let shutdownPromise: Promise<void> | undefined;

function testPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Invalid browser-test port.');
  return Number(value);
}

async function initialize(): Promise<void> {
  // Browser settings tests use only synthetic credentials. No inherited key is
  // supplied to a model, and the injected Pi adapter cannot create a host.
  const config = loadConfig();
  const apiPort = testPort(process.env.NEXRUN_E2E_API_PORT, 3001);
  const webPort = testPort(process.env.NEXRUN_E2E_WEB_PORT, 5173);
  adminPool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  if (stopping) return;
  stateDir = await mkdtemp(join(tmpdir(), 'nexrun-e2e-'));
  if (stopping) return;
  pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema}`, max: 10, connectionTimeoutMillis: 5_000 });
  app = await buildApp({
    pool,
    config: { ...config, host: '127.0.0.1', port: apiPort, allowedOrigins: [...new Set([...config.allowedOrigins, `http://127.0.0.1:${webPort}`])], agentMode: 'mock', responseLanguage: 'auto', adminToken: undefined, encryptionKey: randomBytes(32).toString('base64'), stateDir },
    settingsEnvironment: { NEXRUN_OPENAI_API_KEY: 'e2e-env-key-placeholder-not-real' },
    adapterFactory(settings) {
      if (settings.adapter === 'mock') return createMockAdapter({ responseLanguage: settings.responseLanguage });
      return {
        mode: 'pi', configured: Boolean(settings.apiKey), model: settings.model,
        async generate() { throw Object.assign(new Error('E2E_MODEL_CALL_BLOCKED'), { code: 'UPSTREAM_ERROR' }); },
      };
    },
    async settingsChecker(settings) {
      const code = !settings.apiKey ? 'AGENT_NOT_CONFIGURED' : settings.apiKey.includes('reject') ? 'UPSTREAM_AUTHENTICATION_FAILED' : 'CONNECTION_OK';
      return { ok: code === 'CONNECTION_OK', code, checkedAt: new Date().toISOString(), revision: settings.revision };
    },
  });
  app.server.once('close', () => { if (!stopping) void shutdown(); });
  if (stopping) return;
  await app.listen({ host: '127.0.0.1', port: apiPort });
  if (!stopping) process.stdout.write('E2E API ready.\n');
}

function shutdown(): Promise<void> {
  stopping = true;
  shutdownPromise ??= (async () => {
    // Initialization checks stopping at each boundary. Wait for it to settle so
    // no resource can be created after cleanup has already passed that resource.
    await initialization.catch(() => undefined);
    let cleanupFailed = false;
    try { await app?.close(); } catch { cleanupFailed = true; }
    try { await pool?.end(); } catch { cleanupFailed = true; }
    if (schemaCreated && adminPool) {
      try { await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      catch { cleanupFailed = true; }
    }
    try { await adminPool?.end(); } catch { cleanupFailed = true; }
    if (stateDir) {
      try { await rm(stateDir, { recursive: true, force: true }); }
      catch { cleanupFailed = true; }
    }
    if (cleanupFailed) {
      process.exitCode = 1;
      process.stderr.write('E2E API cleanup failed.\n');
    }
  })();
  return shutdownPromise;
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void shutdown(); });
process.once('beforeExit', () => { void shutdown(); });
const initialization = initialize();
void initialization.catch(() => {
  process.exitCode = 1;
  process.stderr.write('E2E API failed to start.\n');
  void shutdown();
});
