import { execFile, fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentAdapter, AgentInput } from './types.js';
import type { ResponseLanguage } from '@nexrun/protocol';

export interface PiAdapterOptions {
  stateDir: string;
  model?: string;
  provider?: 'openai';
  generationTimeoutMs?: number;
  apiKey?: string | null;
  responseLanguage?: ResponseLanguage;
}

export interface PiHostRequest {
  type: 'generate';
  conversationId: string;
  runId: string;
  conversationDir: string;
  model: string;
  provider: 'openai';
  prompt: string;
  hasPriorHistory: boolean;
  generationTimeoutMs: number;
  responseLanguage?: ResponseLanguage;
}

const ERROR_CODES = new Set([
  'AGENT_NOT_CONFIGURED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_ERROR',
  'RUN_INTERRUPTED', 'GENERATION_TIMEOUT', 'VALIDATION_ERROR',
]);

export type PiFailureDiagnostic = 'authentication' | 'rate_limit' | 'network' | 'configuration' | 'unknown';
const DIAGNOSTICS = new Set<PiFailureDiagnostic>(['authentication', 'rate_limit', 'network', 'configuration', 'unknown']);

export class PiAdapterError extends Error {
  constructor(readonly code: string, readonly diagnostic?: PiFailureDiagnostic) {
    super(code);
    this.name = 'PiAdapterError';
  }
}

function cancelledError(): Error {
  const error = new Error('RUN_CANCELLED');
  error.name = 'AbortError';
  return error;
}

export function piConversationDirectory(stateDir: string, conversationId: string): string {
  return join(resolve(stateDir), createHash('sha256').update(conversationId).digest('hex'));
}

export function selectedPiApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.NEXRUN_OPENAI_API_KEY || env.OPENAI_API_KEY;
}

// The child receives no personal Pi configuration, provider URL overrides, or other credentials.
export function piHostEnvironment(apiKey: string): NodeJS.ProcessEnv {
  return { OPENAI_API_KEY: apiKey, LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'production', PI_TELEMETRY: '0', PI_OFFLINE: '1' };
}

export interface PiHostRecord {
  schemaVersion: 1;
  pid: number;
  marker: string;
  runId: string;
}

const inspectProcess = promisify(execFile);

async function hostIdentity(record: PiHostRecord): Promise<'owned' | 'gone'> {
  const exists = (): boolean => {
    try { process.kill(record.pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw new PiAdapterError('RUN_INTERRUPTED');
    }
  };
  if (!exists()) return 'gone';
  try {
    // These arguments are inspected only in memory and must never enter logs or API errors.
    const { stdout } = await inspectProcess('/bin/ps', ['-p', String(record.pid), '-o', 'args='], { timeout: 2_000, maxBuffer: 256_000 });
    if (!stdout.trim()) {
      if (!exists()) return 'gone';
      throw new PiAdapterError('RUN_INTERRUPTED');
    }
    return stdout.split(/\s+/).includes(`--nexrun-host=${record.marker}`) ? 'owned' : 'gone';
  } catch {
    if (!exists()) return 'gone';
    throw new PiAdapterError('RUN_INTERRUPTED');
  }
}

async function stopRecordedHost(record: PiHostRecord): Promise<void> {
  const signalOwned = async (signal: NodeJS.Signals): Promise<void> => {
    if (await hostIdentity(record) === 'gone') return;
    try { process.kill(record.pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new PiAdapterError('RUN_INTERRUPTED');
    }
  };
  if (await hostIdentity(record) === 'gone') return;
  await signalOwned('SIGTERM');
  for (let check = 0; check < 30; check += 1) {
    if (await hostIdentity(record) === 'gone') return;
    await delay(50);
  }
  await signalOwned('SIGKILL');
  for (let check = 0; check < 30; check += 1) {
    if (await hostIdentity(record) === 'gone') return;
    await delay(50);
  }
  throw new PiAdapterError('RUN_INTERRUPTED');
}

async function recordHost(path: string, record: PiHostRecord): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export async function reconcilePiHosts(stateDir: string): Promise<void> {
  await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 });
  await chmod(resolve(stateDir), 0o700);
  const directory = join(resolve(stateDir), 'hosts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    let record: PiHostRecord;
    try { record = JSON.parse(await readFile(path, 'utf8')) as PiHostRecord; }
    catch { throw new PiAdapterError('RUN_INTERRUPTED'); }
    if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 0
        || typeof record.marker !== 'string' || !/^[a-f0-9-]{36}$/.test(record.marker)
        || name !== `${record.marker}.json` || typeof record.runId !== 'string') {
      throw new PiAdapterError('RUN_INTERRUPTED');
    }
    await stopRecordedHost(record);
    await rm(path);
  }
}

/** Supervise one private IPC invocation. Completion is observed only after host termination. */
export function supervisePiHost(
  child: ChildProcess,
  request: PiHostRequest,
  signal: AbortSignal,
  onText: (text: string) => Promise<void>,
  beforeDispatch?: () => Promise<void>,
): Promise<void> {
  return new Promise((resolveResult, rejectResult) => {
    let ready = false;
    let terminal: 'completed' | 'cancelled' | undefined;
    let failure: Error | undefined;
    let stopping = false;
    let preservePendingOutput = false;
    let exited = false;
    let settled = false;
    let latestText: string | undefined;
    let flushing: Promise<void> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = async (): Promise<void> => {
      if (!exited || settled) return;
      settled = true;
      clearTimeout(lifetime);
      clearTimeout(stopTimer);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      try {
        while (flushing) await flushing;
        if (latestText !== undefined && (!failure || preservePendingOutput) && (!stopping || preservePendingOutput)) {
          await onText(latestText);
        }
      } catch {
        failure = new PiAdapterError('RUN_INTERRUPTED');
      }
      if (failure) rejectResult(failure);
      else if (terminal === 'cancelled') rejectResult(cancelledError());
      else if (terminal === 'completed') resolveResult();
      else rejectResult(new PiAdapterError('RUN_INTERRUPTED'));
    };

    const stop = (error?: Error, preserveText = false): void => {
      failure ??= error;
      if (stopping || exited) return;
      stopping = true;
      preservePendingOutput = preserveText;
      if (!preserveText) latestText = undefined;
      if (child.connected) child.send({ type: 'abort', runId: request.runId }, () => {});
      stopTimer = setTimeout(() => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
        killTimer.unref();
      }, 1_500);
      stopTimer.unref();
    };

    const flush = (): void => {
      if (flushing || latestText === undefined || (stopping && !preservePendingOutput) || terminal) return;
      const text = latestText;
      latestText = undefined;
      flushing = Promise.resolve().then(() => onText(text)).catch(() => {
        failure = new PiAdapterError('RUN_INTERRUPTED');
        preservePendingOutput = false;
        latestText = undefined;
        stop(failure);
      }).finally(() => {
        flushing = undefined;
        if (latestText !== undefined && (!stopping || preservePendingOutput)) flush();
      });
    };

    const onAbort = (): void => { if (!terminal) stop(cancelledError()); };
    const lifetime = setTimeout(() => { if (!terminal) stop(new PiAdapterError('GENERATION_TIMEOUT')); }, request.generationTimeoutMs);
    lifetime.unref();
    signal.addEventListener('abort', onAbort, { once: true });

    child.on('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || exited) return;
      const message = raw as Record<string, unknown>;
      if (message.runId !== request.runId) return;
      if (message.type === 'ready') {
        if (!Array.isArray(message.activeTools) || message.activeTools.length !== 0 || message.resourcesDisabled !== true) {
          stop(new PiAdapterError('RUN_INTERRUPTED'));
        } else ready = true;
      } else if (message.type === 'text' && !stopping && !terminal) {
        if (!ready || typeof message.text !== 'string' || Buffer.byteLength(message.text) > 2_000_000) {
          stop(new PiAdapterError('RUN_INTERRUPTED'));
          return;
        }
        latestText = message.text;
        flush();
      } else if (message.type === 'done' && !terminal) {
        if (message.status !== 'completed' && message.status !== 'cancelled') {
          stop(new PiAdapterError('RUN_INTERRUPTED'));
          return;
        }
        if (!ready && message.status === 'completed') {
          stop(new PiAdapterError('RUN_INTERRUPTED'));
          return;
        }
        terminal = message.status;
        // A wedged host must not keep the API's execution slot forever after acknowledging completion.
        stopTimer ??= setTimeout(() => {
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
          killTimer.unref();
        }, 1_500);
        stopTimer.unref();
      } else if (message.type === 'error' && !terminal) {
        const code = typeof message.code === 'string' && ERROR_CODES.has(message.code) ? message.code : 'UPSTREAM_ERROR';
        const diagnostic = typeof message.diagnostic === 'string' && DIAGNOSTICS.has(message.diagnostic as PiFailureDiagnostic)
          ? message.diagnostic as PiFailureDiagnostic : 'unknown';
        stop(new PiAdapterError(code, diagnostic), true);
      }
    });
    child.once('error', () => stop(new PiAdapterError('RUN_INTERRUPTED')));
    child.once('close', () => { exited = true; void finish(); });
    if (signal.aborted) onAbort();
    else {
      void Promise.resolve().then(beforeDispatch).then(() => {
        if (exited || stopping) return;
        if (child.connected) child.send(request, (error) => { if (error) stop(new PiAdapterError('RUN_INTERRUPTED')); });
        else stop(new PiAdapterError('RUN_INTERRUPTED'));
      }).catch(() => stop(new PiAdapterError('RUN_INTERRUPTED')));
    }
  });
}

export function createPiAdapter(options: PiAdapterOptions): AgentAdapter {
  const model = options.model ?? process.env.PI_MODEL ?? 'gpt-5-mini';
  const provider = options.provider ?? 'openai';
  const timeout = options.generationTimeoutMs ?? 120_000;
  const responseLanguage = options.responseLanguage ?? 'auto';
  if (provider !== 'openai' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)
      || !['auto', 'en', 'zh-CN'].includes(responseLanguage)
      || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900_000) {
    throw new PiAdapterError('VALIDATION_ERROR');
  }
  const apiKey = options.apiKey === undefined ? selectedPiApiKey() : options.apiKey || undefined;
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let disposed = false;
  let reconciling = false;
  let recoveryBlocked = false;
  const hostUrl = new URL(import.meta.url.endsWith('.ts') ? './pi-host.ts' : './pi-host.js', import.meta.url);

  return {
    mode: 'pi', configured: Boolean(apiKey), model,
    async reconcile(): Promise<void> {
      if (active.size || reconciling) throw new PiAdapterError('RUN_INTERRUPTED');
      reconciling = true;
      recoveryBlocked = true;
      try { await reconcilePiHosts(options.stateDir); recoveryBlocked = false; }
      catch { throw new PiAdapterError('RUN_INTERRUPTED'); }
      finally { reconciling = false; }
    },
    async generate(input: AgentInput, onText): Promise<void> {
      if (disposed || reconciling || recoveryBlocked) throw new PiAdapterError('RUN_INTERRUPTED');
      if (!apiKey) throw new PiAdapterError('AGENT_NOT_CONFIGURED', 'configuration');
      if (input.signal.aborted) throw cancelledError();
      if (active.has(input.conversationId)) throw new PiAdapterError('CONVERSATION_BUSY');
      if (!input.conversationId || !input.runId || !input.prompt || Buffer.byteLength(input.prompt) > 100_000) {
        throw new PiAdapterError('VALIDATION_ERROR');
      }
      const controller = new AbortController();
      const relayAbort = (): void => controller.abort();
      input.signal.addEventListener('abort', relayAbort, { once: true });
      const promise = (async () => {
        const conversationDir = piConversationDirectory(options.stateDir, input.conversationId);
        await mkdir(resolve(options.stateDir), { recursive: true, mode: 0o700 });
        await chmod(resolve(options.stateDir), 0o700);
        await mkdir(conversationDir, { recursive: true, mode: 0o700 });
        await chmod(conversationDir, 0o700);
        if (controller.signal.aborted) throw cancelledError();
        const marker = randomUUID();
        const registryDir = join(resolve(options.stateDir), 'hosts');
        await mkdir(registryDir, { recursive: true, mode: 0o700 });
        await chmod(registryDir, 0o700);
        const registryPath = join(registryDir, `${marker}.json`);
        const child = fork(fileURLToPath(hostUrl), [`--nexrun-host=${marker}`], {
          cwd: conversationDir,
          env: piHostEnvironment(apiKey),
          execArgv: hostUrl.pathname.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          serialization: 'json',
        });
        try { await supervisePiHost(child, {
          type: 'generate', conversationId: input.conversationId, runId: input.runId,
          conversationDir, model, provider, prompt: input.prompt,
          hasPriorHistory: input.history.length > 0, generationTimeoutMs: timeout,
          responseLanguage,
        }, controller.signal, onText, async () => {
          if (!child.pid) throw new PiAdapterError('RUN_INTERRUPTED');
          await recordHost(registryPath, { schemaVersion: 1, pid: child.pid, marker, runId: input.runId });
        }); } finally { await rm(registryPath, { force: true }); }
      })();
      active.set(input.conversationId, { controller, promise });
      try { await promise; }
      catch (error) {
        if (error instanceof PiAdapterError || (error instanceof Error && error.name === 'AbortError')) throw error;
        throw new PiAdapterError('RUN_INTERRUPTED');
      }
      finally {
        active.delete(input.conversationId);
        input.signal.removeEventListener('abort', relayAbort);
      }
    },
    async dispose(): Promise<void> {
      disposed = true;
      for (const invocation of active.values()) invocation.controller.abort();
      await Promise.allSettled([...active.values()].map((invocation) => invocation.promise));
    },
  };
}
