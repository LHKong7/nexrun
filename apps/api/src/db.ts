import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

export class TransactionCommitUnknownError extends Error {
  readonly code = 'TRANSACTION_COMMIT_UNKNOWN';
  constructor() {
    super('TRANSACTION_COMMIT_UNKNOWN');
    this.name = 'TransactionCommitUnknownError';
  }
}

export async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  let commitFailed = false;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    try { await client.query('COMMIT'); }
    catch {
      // A lost acknowledgement cannot establish whether PostgreSQL committed.
      // A subsequent ROLLBACK does not undo an already completed COMMIT.
      discard = true;
      commitFailed = true;
      try { await client.query('ROLLBACK'); } catch { /* Preserve the unknown-outcome classification. */ }
      throw new TransactionCommitUnknownError();
    }
    return result;
  } catch (error) {
    if (!commitFailed) {
      try { await client.query('ROLLBACK'); }
      catch { discard = true; }
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

export async function migrate(pool: Pool): Promise<void> {
  const migrations = await Promise.all([
    [1, '001_initial.sql'],
    [2, '002_admin_settings.sql'],
    [3, '003_agent_foundations.sql'],
    [4, '004_resources.sql'],
  ].map(async ([version, file]) => ({ version, sql: await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8') })));
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('nexrun-migrations'), hashtext(current_schema()))");
    await client.query('CREATE TABLE IF NOT EXISTS nexrun_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const migration of migrations) {
      const result = await client.query('SELECT version FROM nexrun_migrations WHERE version = $1', [migration.version]);
      if (result.rowCount) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO nexrun_migrations (version) VALUES ($1)', [migration.version]);
    }
  });
}
