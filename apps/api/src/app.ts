import Fastify, { type FastifyInstance } from 'fastify';
import { Pool, type PoolClient } from 'pg';
import type { ServerResponse } from 'node:http';
import type { ApiError, CredentialCheck, RuntimeConfig } from '@nexrun/protocol';
import { loadConfig, type ApiConfig } from './config.js';
import { migrate, TransactionCommitUnknownError } from './db.js';
import { AppError, validation } from './errors.js';
import { ChatStore } from './store.js';
import { Dispatcher } from './dispatcher.js';
import { createMockAdapter } from './agents/mock.js';
import { createPiAdapter } from './agents/pi.js';
import type { AgentAdapter } from './agents/types.js';
import { SettingsStore, adminAccess, authorizeAdmin, checkOpenAiCredential, type EffectiveSettings } from './settings.js';
import { AdmissionGate, RuntimeAdapter } from './runtime.js';

export interface BuildAppOptions {
  config?: Partial<ApiConfig>;
  adapter?: AgentAdapter;
  pool?: Pool;
  reconcileOnStart?: boolean;
  adapterFactory?: (settings: EffectiveSettings) => AgentAdapter;
  settingsChecker?: (settings: EffectiveSettings) => Promise<CredentialCheck>;
  settingsEnvironment?: NodeJS.ProcessEnv;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value: unknown, missingCode: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new AppError(missingCode, 404);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) validation();
  return value as Record<string, unknown>;
}
function number(value: unknown, fallback: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) validation();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) validation();
  return parsed;
}
function title(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0') || Array.from(value).length > 120) validation({ field: 'title' });
  return value.trim();
}
function noExtraKeys(body: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) validation();
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...options.config };
  const pool = options.pool ?? new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 20_000 });
  let singleton: PoolClient | undefined;
  let dispatcher: Dispatcher | undefined;
  const streams = new Set<ServerResponse>();
  const app = Fastify({ logger: false, bodyLimit: 100_000, requestTimeout: 30_000 });
  let configurationAvailable = true;
  const failClosed = (): void => {
    if (!configurationAvailable) return;
    configurationAvailable = false;
    queueMicrotask(() => { void app.close().catch(() => undefined); });
  };
  try {
    singleton = await pool.connect();
    const lock = await singleton.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('nexrun-sprint1-api'), hashtext(current_schema())) AS acquired");
    if (!lock.rows[0]?.acquired) throw new Error('Another API instance owns this database schema.');
    await migrate(pool);
    if (options.adapter) config.agentMode = options.adapter.mode;
    const settings = new SettingsStore(pool, config, { environment: options.settingsEnvironment ?? process.env });
    await settings.initialize();
    const factory = options.adapterFactory ?? ((effective: EffectiveSettings): AgentAdapter => effective.adapter === 'pi'
      ? createPiAdapter({ stateDir: config.stateDir, model: effective.model, provider: effective.provider, generationTimeoutMs: config.generationTimeoutMs, apiKey: effective.apiKey ?? null, responseLanguage: effective.responseLanguage })
      : createMockAdapter({ responseLanguage: effective.responseLanguage }));
    const applyConfig = (effective: EffectiveSettings): void => {
      config.agentMode = effective.adapter;
      config.provider = effective.provider;
      config.model = effective.model;
      config.responseLanguage = effective.responseLanguage;
    };
    applyConfig(settings.getEffective());
    const adapter = new RuntimeAdapter(options.adapter ?? factory(settings.getEffective()));
    config.agentMode = adapter.mode;
    const admission = new AdmissionGate();
    const store = new ChatStore(pool, config);
    dispatcher = new Dispatcher(store, adapter, config, failClosed);
    if (options.reconcileOnStart !== false) {
      // Runtime changes do not make hosts from the previous Pi mode disappear.
      // A recovery-only adapter never submits a model request or needs a valid key.
      if (adapter.mode === 'mock') {
        const recoveryAdapter = createPiAdapter({ stateDir: config.stateDir, ...(config.model ? { model: config.model } : {}), provider: config.provider, generationTimeoutMs: config.generationTimeoutMs });
        try { await recoveryAdapter.reconcile?.(); }
        finally { await recoveryAdapter.dispose?.(); }
      }
      await adapter.reconcile?.();
      await store.interruptAbandoned();
    }
    const execution = dispatcher;
    singleton.on('error', () => { void app.close().catch(() => undefined); });

    app.addHook('onRequest', async (request, reply) => {
      const host = request.headers.host?.toLowerCase();
      if (!host || !/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/.test(host)) throw new AppError('ACCESS_DENIED', 403);
      const hostname = host.replace(/:\d+$/, '');
      if (!config.allowedHosts.includes(host) && !config.allowedHosts.includes(hostname)) throw new AppError('ACCESS_DENIED', 403);
      const origin = request.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) throw new AppError('ACCESS_DENIED', 403);
      if (!origin && request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('ACCESS_DENIED', 403);
      if (origin) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
      }
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'no-store');
      if (request.method === 'OPTIONS') {
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, Last-Event-ID, Authorization');
        return reply.code(204).send();
      }
    });

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof TransactionCommitUnknownError || (error instanceof AppError && error.code === 'SETTINGS_COMMIT_UNKNOWN')) {
        failClosed();
        return reply.code(503).send({ error: { code: 'SETTINGS_COMMIT_UNKNOWN', message: 'SETTINGS_COMMIT_UNKNOWN' } } satisfies ApiError);
      }
      const known = error instanceof AppError;
      const suppliedStatus = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
      const code = known ? error.code : suppliedStatus && suppliedStatus < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
      const statusCode = known ? error.statusCode : suppliedStatus && suppliedStatus < 500 ? suppliedStatus : 500;
      const body: ApiError = { error: { code, message: code, ...(known && error.parameters ? { parameters: error.parameters } : {}) } };
      void reply.code(statusCode).send(body);
    });
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'NOT_FOUND' } } satisfies ApiError));

    app.get('/healthz', async () => ({ status: 'ok' }));
    app.get('/api/config', async (): Promise<RuntimeConfig> => {
      if (!configurationAvailable) throw new AppError('SETTINGS_UNAVAILABLE', 503);
      return { adapter: adapter.mode, configured: adapter.configured, model: adapter.model, responseLanguage: config.responseLanguage ?? 'auto' };
    });
    const activeCount = async (): Promise<number> => {
      const result = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE c.owner_id = $1 AND r.status IN ('queued', 'running', 'cancelling')", [config.ownerId]);
      return Math.max(result.rows[0]!.count, execution.activeCount);
    };
    app.get('/api/admin/access', async request => adminAccess(request, config));
    app.get('/api/admin/settings', async request => {
      authorizeAdmin(request, config);
      if (!configurationAvailable) throw new AppError('SETTINGS_UNAVAILABLE', 503);
      return settings.getPublic(await activeCount());
    });
    app.patch('/api/admin/settings', async request => {
      authorizeAdmin(request, config);
      return admission.run(async () => {
        if (!configurationAvailable) throw new AppError('SETTINGS_UNAVAILABLE', 503);
        const update = await settings.prepareUpdate(request.body);
        if (execution.busy || await activeCount()) throw new AppError('SETTINGS_BUSY', 409);
        const prospective = settings.preview(update);
        let next: AgentAdapter;
        try {
          next = factory(prospective);
          if (next.mode !== prospective.adapter) throw new Error('Invalid adapter factory result.');
        } catch { throw new AppError('CONFIGURATION_ERROR', 500); }
        try { await settings.update(update); }
        catch (error) {
          if (error instanceof TransactionCommitUnknownError || (error instanceof AppError && error.code === 'SETTINGS_COMMIT_UNKNOWN')) failClosed();
          await next.dispose?.().catch(() => undefined);
          throw error;
        }
        const previous = adapter.replace(next);
        applyConfig(settings.getEffective());
        try { await previous.dispose?.(); }
        catch {
          failClosed();
          throw new AppError('CONFIGURATION_ERROR', 500);
        }
        return settings.getPublic(await activeCount());
      });
    });
    app.post('/api/admin/connection-check', async request => {
      authorizeAdmin(request, config);
      const body = object(request.body);
      noExtraKeys(body, ['revision']);
      if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) validation({ field: 'revision' });
      const effective = await admission.run(async () => {
        if (!configurationAvailable) throw new AppError('SETTINGS_UNAVAILABLE', 503);
        const current = settings.getEffective();
        if (body.revision !== current.revision) throw new AppError('SETTINGS_CONFLICT', 409);
        return current;
      });
      try { return await (options.settingsChecker ?? checkOpenAiCredential)(effective); }
      catch { return { ok: false, code: 'NETWORK_ERROR', checkedAt: new Date().toISOString(), revision: effective.revision } satisfies CredentialCheck; }
    });
    app.get<{ Querystring: { cursor?: string; limit?: string } }>('/api/conversations', async (request) => {
      const limit = number(request.query.limit, 30, 1, 100)!;
      let cursor: { updatedAt: string; id: string } | undefined;
      if (request.query.cursor !== undefined) {
        if (request.query.cursor.length > 300) validation();
        try {
          const parsed = JSON.parse(Buffer.from(request.query.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
          if (typeof parsed.updatedAt !== 'string' || Number.isNaN(Date.parse(parsed.updatedAt)) || typeof parsed.id !== 'string' || !uuidPattern.test(parsed.id)) validation();
          cursor = { updatedAt: parsed.updatedAt, id: parsed.id };
        } catch { validation(); }
      }
      return store.listConversations(limit, cursor);
    });
    app.post('/api/conversations', async (request, reply) => {
      const body = object(request.body ?? {});
      noExtraKeys(body, ['title']);
      const conversation = await store.createConversation(body.title === undefined ? undefined : title(body.title));
      return reply.code(201).send(conversation);
    });
    app.patch<{ Params: { id: string } }>('/api/conversations/:id', async (request) => {
      const conversationId = id(request.params.id, 'CONVERSATION_NOT_FOUND');
      const body = object(request.body);
      noExtraKeys(body, ['title', 'archived']);
      if (body.title === undefined && body.archived === undefined) validation();
      if (body.archived !== undefined && typeof body.archived !== 'boolean') validation();
      return store.patchConversation(conversationId, { ...(body.title !== undefined ? { title: title(body.title) } : {}), ...(body.archived !== undefined ? { archived: body.archived as boolean } : {}) });
    });
    app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>('/api/conversations/:id/messages', async (request) => store.snapshot(id(request.params.id, 'CONVERSATION_NOT_FOUND'), number(request.query.limit, 50, 1, 100)!, number(request.query.before, undefined, 1, Number.MAX_SAFE_INTEGER)));
    app.post<{ Params: { id: string } }>('/api/conversations/:id/messages', async (request, reply) => {
      const conversationId = id(request.params.id, 'CONVERSATION_NOT_FOUND');
      const body = object(request.body);
      noExtraKeys(body, ['content']);
      if (typeof body.content !== 'string' || !body.content.trim() || body.content.includes('\0') || body.content.length > config.maxInputCharacters) validation({ field: 'content', maximum: config.maxInputCharacters });
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(key)) validation({ field: 'Idempotency-Key' });
      const accepted = await admission.run(async () => {
        if (!configurationAvailable) throw new AppError('SETTINGS_UNAVAILABLE', 503);
        try {
          const result = await store.acceptMessage(conversationId, body.content as string, key, adapter.configured);
          execution.wake();
          return result;
        } catch (error) {
          if (error instanceof TransactionCommitUnknownError) failClosed();
          throw error;
        }
      });
      return reply.code(202).send(accepted);
    });
    app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => store.getRun(id(request.params.id, 'RUN_NOT_FOUND')));
    app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request) => {
      if (request.body !== undefined) noExtraKeys(object(request.body), []);
      const run = await store.cancelRun(id(request.params.id, 'RUN_NOT_FOUND'));
      if (run.status === 'cancelling') execution.cancel(run.id);
      return run;
    });
    app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/conversations/:id/events', async (request, reply) => {
      const conversationId = id(request.params.id, 'CONVERSATION_NOT_FOUND');
      let cursor = number(request.query.after, 0, 0, Number.MAX_SAFE_INTEGER)!;
      if (request.headers['last-event-id'] !== undefined) cursor = number(request.headers['last-event-id'], undefined, 0, Number.MAX_SAFE_INTEGER)!;
      const batchSize = 16;
      const initial = await store.events(conversationId, cursor, batchSize);
      if (streams.size >= 16) throw new AppError('STREAM_LIMIT', 503);
      const response = reply.raw;
      reply.hijack();
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', ...(request.headers.origin ? { 'Access-Control-Allow-Origin': request.headers.origin, Vary: 'Origin' } : {}) });
      streams.add(response);
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lastWrite = Date.now();
      const close = (): void => { closed = true; if (timer) clearTimeout(timer); streams.delete(response); };
      response.on('close', close);
      const writeEvents = (events: Awaited<ReturnType<ChatStore['events']>>): boolean => {
        for (const event of events) {
          if (response.writableLength > 512_000) { response.end(); return false; }
          if (!response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)) { response.end(); return false; }
          cursor = event.sequence;
          lastWrite = Date.now();
        }
        return true;
      };
      const poll = async (): Promise<void> => {
        if (closed || response.destroyed || response.writableEnded) return;
        try {
          const events = await store.events(conversationId, cursor, batchSize);
          if (closed) return;
          if (!writeEvents(events)) return;
          if (Date.now() - lastWrite >= config.eventHeartbeatMs) { response.write(': heartbeat\n\n'); lastWrite = Date.now(); }
          timer = setTimeout(() => { void poll(); }, events.length === batchSize ? 0 : config.eventPollMs);
        } catch (error) {
          if (!response.destroyed && !response.writableEnded) {
            response.write(`event: ${error instanceof AppError && error.code === 'RESYNC_REQUIRED' ? 'resync_required' : 'stream_error'}\ndata: {"code":"${error instanceof AppError && error.code === 'RESYNC_REQUIRED' ? 'RESYNC_REQUIRED' : 'STREAM_UNAVAILABLE'}"}\n\n`);
            response.end();
          }
        }
      };
      response.write('retry: 1000\n\n');
      if (writeEvents(initial)) timer = setTimeout(() => { void poll(); }, config.eventPollMs);
    });

    app.addHook('preClose', async () => {
      for (const stream of streams) stream.end();
      streams.clear();
      await execution.close();
    });
    app.addHook('onClose', async () => {
      if (singleton) {
        await singleton.query("SELECT pg_advisory_unlock(hashtext('nexrun-sprint1-api'), hashtext(current_schema()))").catch(() => undefined);
        singleton.release();
        singleton = undefined;
      }
      if (!options.pool) await pool.end();
    });
    await app.ready();
    return app;
  } catch (error) {
    await dispatcher?.close();
    if (singleton) {
      await singleton.query("SELECT pg_advisory_unlock(hashtext('nexrun-sprint1-api'), hashtext(current_schema()))").catch(() => undefined);
      singleton.release();
    }
    if (!options.pool) await pool.end();
    throw error;
  }
}
