import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

export async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('nexrun-migrations'), hashtext(current_schema()))");
    await client.query('CREATE TABLE IF NOT EXISTS nexrun_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const result = await client.query('SELECT version FROM nexrun_migrations WHERE version = 1');
    if (result.rowCount) return;
    await client.query(sql);
    await client.query('INSERT INTO nexrun_migrations (version) VALUES (1)');
  });
}
