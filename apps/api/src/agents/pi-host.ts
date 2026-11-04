import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  AgentSession, CreateAgentSessionOptions, ExtensionRuntime, ResourceLoader, SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { PiFailureDiagnostic, PiHostRequest } from './pi.js';

const SYSTEM_PROMPT = 'You are a helpful text conversation assistant. You have no tools, filesystem access, shell, browser, extensions, or external actions. Respond to the user in their requested language.';

/** The host owns all resources; no default loader or filesystem discovery is used. */
export function createTextOnlyResourceLoader(createRuntime: () => ExtensionRuntime): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('RESOURCE_LOADING_DISABLED'); },
    reload: async () => {},
  };
}

export function classifyPiError(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
    if (value.code === 'AGENT_NOT_CONFIGURED' || value.code === 'RUN_INTERRUPTED' || value.code === 'VALIDATION_ERROR' || value.code === 'UPSTREAM_RATE_LIMITED') {
      return value.code;
    }
    if (value.status === 429 || value.statusCode === 429 || value.code === 'rate_limit_exceeded'
      || (typeof value.message === 'string' && /\b429\b|rate.?limit|quota.?exceeded|insufficient_quota/i.test(value.message))) {
      return 'UPSTREAM_RATE_LIMITED';
    }
  }
  return 'UPSTREAM_ERROR';
}

export function classifyPiDiagnostic(error: unknown): PiFailureDiagnostic {
  if (!error || typeof error !== 'object') return 'unknown';
  const value = error as { code?: unknown; diagnostic?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  const allowed = ['authentication', 'rate_limit', 'network', 'configuration', 'unknown'];
  if (typeof value.diagnostic === 'string' && allowed.includes(value.diagnostic)) return value.diagnostic as PiFailureDiagnostic;
  if (value.code === 'AGENT_NOT_CONFIGURED' || value.code === 'VALIDATION_ERROR') return 'configuration';
  const message = typeof value.message === 'string' ? value.message : '';
  if (value.status === 401 || value.statusCode === 401 || value.status === 403 || value.statusCode === 403
      || /\b401\b|\b403\b|invalid.?api.?key|incorrect api key|unauthorized|authentication/i.test(message)) return 'authentication';
  if (classifyPiError(error) === 'UPSTREAM_RATE_LIMITED') return 'rate_limit';
  if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|network|certificate/i.test(message)) return 'network';
  return 'unknown';
}

function codedError(code: string, diagnostic?: PiFailureDiagnostic): Error & { code: string; diagnostic?: PiFailureDiagnostic } {
  return Object.assign(new Error(code), { code, diagnostic });
}

interface NativeManifest {
  schemaVersion: 1;
  conversationId: string;
  nativeSessionId: string;
  nativeSessionFile: string;
  nativeSessionVersion: number;
  sdkVersion: string;
  provider: 'openai';
  model: string;
  lastRunId: string;
  state: 'running' | 'completed' | 'cancelled' | 'failed';
}

type PiSdk = typeof import('@earendil-works/pi-coding-agent');

export async function textOnlySessionOptions(
  sdk: PiSdk,
  cwd: string,
  agentDir: string,
  sessionManager: SessionManager,
  modelId: string,
): Promise<CreateAgentSessionOptions> {
  // Empty in-memory credential storage and settings avoid all personal auth/settings.
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: {
      read: async () => undefined, list: async () => [],
      modify: async () => { throw codedError('AGENT_NOT_CONFIGURED'); },
      delete: async () => {},
    },
    modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const model = modelRuntime.getModel('openai', modelId);
  if (!model || model.provider !== 'openai') throw codedError('AGENT_NOT_CONFIGURED');
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: 'off', enableInstallTelemetry: false,
    enableSkillCommands: false, defaultTools: [], images: { blockImages: true },
  });
  return {
    cwd, agentDir, modelRuntime, model, thinkingLevel: 'off',
    tools: [], noTools: 'all', customTools: [],
    resourceLoader: createTextOnlyResourceLoader(sdk.createExtensionRuntime),
    settingsManager, sessionManager,
  };
}

async function readManifest(path: string): Promise<NativeManifest | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as NativeManifest; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw codedError('RUN_INTERRUPTED');
  }
}

async function saveManifest(path: string, manifest: NativeManifest): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function isRequest(raw: unknown): raw is PiHostRequest {
  if (!raw || typeof raw !== 'object') return false;
  const request = raw as Record<string, unknown>;
  return request.type === 'generate' && typeof request.conversationId === 'string'
    && typeof request.runId === 'string' && typeof request.conversationDir === 'string'
    && typeof request.prompt === 'string' && Buffer.byteLength(request.prompt) <= 100_000
    && request.provider === 'openai' && typeof request.model === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.model)
    && typeof request.generationTimeoutMs === 'number'
    && Number.isSafeInteger(request.generationTimeoutMs)
    && request.generationTimeoutMs > 0 && request.generationTimeoutMs <= 900_000;
}

function send(message: object): Promise<void> {
  return new Promise((resolveSend) => {
    if (!process.connected || !process.send) { resolveSend(); return; }
    try { process.send(message, undefined, undefined, () => resolveSend()); }
    catch { resolveSend(); }
  });
}

/** One process accepts exactly one run and exits after its final IPC acknowledgement. */
export function startPiHost(): void {
  process.umask(0o077);
  let session: AgentSession | undefined;
  let accepted: PiHostRequest | undefined;
  let aborted = false;
  let finishing = false;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;

  const requestAbort = (): void => {
    aborted = true;
    if (!hardStop) hardStop = setTimeout(() => process.exit(1), 1_200);
    // abort() can reject while initialization or the transport is shutting down.
    void session?.abort().catch(() => {});
  };
  process.once('disconnect', requestAbort);
  process.once('SIGTERM', requestAbort);
  process.once('SIGINT', requestAbort);
  process.on('message', (raw: unknown) => {
    if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).type === 'abort') {
      if (!accepted || (raw as Record<string, unknown>).runId === accepted.runId) requestAbort();
      return;
    }
    if (accepted || !isRequest(raw)) return;
    accepted = raw;
    lifetime = setTimeout(requestAbort, raw.generationTimeoutMs);
    void generate(raw).catch(async (error: unknown) => {
      await send({ type: 'error', runId: raw.runId, code: classifyPiError(error), diagnostic: classifyPiDiagnostic(error) });
    }).finally(() => {
      finishing = true;
      clearTimeout(lifetime);
      clearTimeout(hardStop);
      try { session?.dispose(); } catch { /* The host still exits on disposal failure. */ }
      if (process.connected) process.disconnect();
      process.exit(0);
    });
  });

  // Even a parent that never dispatches cannot leave an idle host alive indefinitely.
  const startup = setTimeout(() => { if (!accepted) process.exit(1); }, 10_000);
  startup.unref();

  async function generate(request: PiHostRequest): Promise<void> {
    const conversationDir = await realpath(request.conversationDir);
    if (conversationDir !== await realpath(process.cwd())) throw codedError('VALIDATION_ERROR');
    const cwd = join(conversationDir, 'workspace');
    const agentDir = join(conversationDir, 'agent');
    const sessionsDir = join(conversationDir, 'sessions');
    const manifestPath = join(conversationDir, 'native-session.json');
    for (const directory of [cwd, agentDir, sessionsDir]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    const sdk = await import('@earendil-works/pi-coding-agent');
    if (aborted || !process.connected) {
      await send({ type: 'done', runId: request.runId, status: 'cancelled' });
      return;
    }
    let manifest = await readManifest(manifestPath);
    let manager: SessionManager;
    if (manifest) {
      if (manifest.schemaVersion !== 1 || manifest.conversationId !== request.conversationId
          || manifest.sdkVersion !== sdk.VERSION || typeof manifest.nativeSessionFile !== 'string'
          || dirname(manifest.nativeSessionFile) !== sessionsDir
          || !basename(manifest.nativeSessionFile).endsWith('.jsonl')) throw codedError('RUN_INTERRUPTED');
      const nativeFile = await stat(manifest.nativeSessionFile).catch(() => undefined);
      if (!nativeFile?.isFile()) throw codedError('RUN_INTERRUPTED');
      manager = sdk.SessionManager.open(manifest.nativeSessionFile, sessionsDir, cwd);
      if (manager.getSessionId() !== manifest.nativeSessionId
          || manager.getHeader()?.version !== manifest.nativeSessionVersion
          || (request.hasPriorHistory && manager.buildSessionContext().messages.length === 0)) {
        throw codedError('RUN_INTERRUPTED');
      }
    } else {
      // Database history must not silently turn into a new, context-free native session.
      if (request.hasPriorHistory) throw codedError('RUN_INTERRUPTED');
      manager = sdk.SessionManager.create(cwd, sessionsDir);
    }
    const options = await textOnlySessionOptions(sdk, cwd, agentDir, manager, request.model);
    const created = await sdk.createAgentSession(options);
    session = created.session;
    const resources = options.resourceLoader!;
    if (session.getActiveToolNames().length !== 0 || resources.getExtensions().extensions.length !== 0
        || resources.getSkills().skills.length !== 0 || resources.getPrompts().prompts.length !== 0
        || resources.getAgentsFiles().agentsFiles.length !== 0 || resources.getThemes().themes.length !== 0) {
      throw codedError('RUN_INTERRUPTED');
    }
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw codedError('RUN_INTERRUPTED');
    manifest = {
      schemaVersion: 1, conversationId: request.conversationId,
      nativeSessionId: manager.getSessionId(), nativeSessionFile: sessionFile,
      nativeSessionVersion: manager.getHeader()?.version ?? sdk.CURRENT_SESSION_VERSION,
      sdkVersion: sdk.VERSION, provider: 'openai', model: request.model,
      lastRunId: request.runId, state: 'running',
    };
    await saveManifest(manifestPath, manifest);
    await send({ type: 'ready', runId: request.runId, activeTools: [], resourcesDisabled: true, session: {
      id: manifest.nativeSessionId, file: manifest.nativeSessionFile, version: manifest.nativeSessionVersion, sdkVersion: manifest.sdkVersion,
    } });
    if (aborted || !process.connected) {
      manifest.state = 'cancelled';
      await saveManifest(manifestPath, manifest);
      await send({ type: 'done', runId: request.runId, status: 'cancelled' });
      return;
    }
    let fullText = '';
    let failureCode: string | undefined;
    let failureDiagnostic: PiFailureDiagnostic | undefined;
    let lastEmission = 0;
    let pendingEmission: ReturnType<typeof setTimeout> | undefined;
    const emitText = (): void => {
      clearTimeout(pendingEmission);
      pendingEmission = undefined;
      if (!aborted && !finishing) {
        lastEmission = Date.now();
        void send({ type: 'text', runId: request.runId, text: fullText });
      }
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && !aborted) {
        fullText += event.assistantMessageEvent.delta;
        if (Buffer.byteLength(fullText) > 2_000_000) { failureCode = 'UPSTREAM_ERROR'; requestAbort(); return; }
        if (Date.now() - lastEmission >= 30) emitText();
        else pendingEmission ??= setTimeout(emitText, 30);
      } else if (event.type === 'message_end' && event.message.role === 'assistant') {
        // The finalized message is authoritative and preserves exact whitespace.
        fullText = event.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
        if (event.message.stopReason === 'error') {
          failureCode = classifyPiError({ message: event.message.errorMessage });
          failureDiagnostic = classifyPiDiagnostic({ message: event.message.errorMessage });
        }
        else if (event.message.stopReason === 'aborted') aborted = true;
      } else if (event.type === 'tool_execution_start') {
        failureCode = 'UPSTREAM_ERROR';
        requestAbort();
      }
    });
    try {
      // Slash commands, skills, templates and extension input expansion stay disabled for all text.
      await session.prompt(request.prompt, { expandPromptTemplates: false });
      if (failureCode) throw codedError(failureCode, failureDiagnostic);
      if (!aborted) await send({ type: 'text', runId: request.runId, text: fullText });
      manifest.state = aborted ? 'cancelled' : 'completed';
      await chmod(sessionFile, 0o600);
      await saveManifest(manifestPath, manifest);
      if (aborted) await send({ type: 'abort_ack', runId: request.runId });
      await send({ type: 'done', runId: request.runId, status: manifest.state, session: {
        id: manifest.nativeSessionId, file: manifest.nativeSessionFile, version: manifest.nativeSessionVersion, sdkVersion: manifest.sdkVersion,
      } });
    } catch (error) {
      if (!aborted && fullText) await send({ type: 'text', runId: request.runId, text: fullText });
      manifest.state = aborted ? 'cancelled' : 'failed';
      await saveManifest(manifestPath, manifest);
      if (aborted && !failureCode) {
        await send({ type: 'abort_ack', runId: request.runId });
        await send({ type: 'done', runId: request.runId, status: 'cancelled' });
      } else throw error;
    } finally {
      clearTimeout(pendingEmission);
      unsubscribe();
    }
  }
}

if (process.send && process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startPiHost();
}
