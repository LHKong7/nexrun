import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp({ config });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}
await app.listen({ host: config.host, port: config.port });
process.stdout.write(`NexRun API listening on http://${config.host}:${config.port}\n`);
