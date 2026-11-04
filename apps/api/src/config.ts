import { resolve } from 'node:path';

export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  ownerId: string;
  agentMode: 'mock' | 'pi';
  stateDir: string;
  model?: string;
  provider: 'openai';
  allowedHosts: string[];
  allowedOrigins: string[];
  maxConcurrentRuns: number;
  generationTimeoutMs: number;
  maxInputCharacters: number;
  maxOutputCharacters: number;
  eventPollMs: number;
  eventHeartbeatMs: number;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Invalid numeric server configuration.');
  }
  return parsed;
}

function list(value: string | undefined, fallback: string[]): string[] {
  return value === undefined ? fallback : value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const agentMode = env.AGENT_MODE ?? 'mock';
  if (agentMode !== 'mock' && agentMode !== 'pi') throw new Error('Invalid AGENT_MODE.');
  if (env.PI_PROVIDER && env.PI_PROVIDER !== 'openai') throw new Error('Unsupported PI_PROVIDER.');
  const port = integer(env.API_PORT ?? env.PORT, 3001, 1, 65535);
  return {
    host: env.API_HOST ?? '127.0.0.1',
    port,
    databaseUrl: env.DATABASE_URL ?? 'postgres://nexrun:nexrun@127.0.0.1:55439/nexrun',
    ownerId: 'development-owner',
    agentMode,
    stateDir: resolve(env.PI_STATE_DIR ?? '.data/pi'),
    ...(env.PI_MODEL ? { model: env.PI_MODEL } : {}),
    provider: 'openai',
    allowedHosts: list(env.ALLOWED_HOSTS, [`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173']),
    allowedOrigins: list(env.ALLOWED_ORIGINS, [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173']),
    maxConcurrentRuns: integer(env.MAX_CONCURRENT_RUNS, 2, 1, 16),
    generationTimeoutMs: integer(env.GENERATION_TIMEOUT_MS, 120_000, 100, 600_000),
    maxInputCharacters: 16_000,
    maxOutputCharacters: 200_000,
    eventPollMs: 150,
    eventHeartbeatMs: 15_000,
  };
}
