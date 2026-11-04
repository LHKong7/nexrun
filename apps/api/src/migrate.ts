import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { migrate } from './db.js';

const pool = new Pool({ connectionString: loadConfig().databaseUrl });
try {
  await migrate(pool);
  process.stdout.write('Database migrations applied.\n');
} finally {
  await pool.end();
}
