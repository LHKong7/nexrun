import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// The generated identifier never includes an environment variable or user input.
const schema = `nexrun_e2e_${process.pid}_${randomBytes(8).toString('hex')}`;
let adminPool: Pool | undefined;
let pool: Pool | undefined;
let app: FastifyInstance | undefined;
let stateDir: string | undefined;
let schemaCreated = false;
let stopping = false;
let shutdownPromise: Promise<void> | undefined;

async function initialize(): Promise<void> {
  const config = loadConfig();
  adminPool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  if (stopping) return;
  stateDir = await mkdtemp(join(tmpdir(), 'nexrun-e2e-'));
  if (stopping) return;
  pool = new Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema}`, max: 10, connectionTimeoutMillis: 5_000 });
  app = await buildApp({ pool, config: { ...config, host: '127.0.0.1', port: 3001, agentMode: 'mock', stateDir } });
  app.server.once('close', () => { if (!stopping) void shutdown(); });
  if (stopping) return;
  await app.listen({ host: '127.0.0.1', port: 3001 });
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
