import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { migrate } from './db.js';
import { assertDemoConfiguration, seedDemo } from './demo-fixtures.js';

const config = loadConfig();
assertDemoConfiguration(config);
const pool = new Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 5_000 });
try {
  await migrate(pool);
  const result = await seedDemo(pool, config);
  console.log(JSON.stringify({ dataset: 'nexrun-demo-v1', ...result }));
} catch {
  console.error('Demo seed failed. No partial fixture batch was committed.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
