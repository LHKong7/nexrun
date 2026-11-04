import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rm } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { AdminAccess, AdminSettings, AdminSettingsUpdate, CredentialCheck, CredentialSource, ModelOption, ResponseLanguage } from '@nexrun/protocol';
import type { ApiConfig } from './config.js';
import { transaction, TransactionCommitUnknownError } from './db.js';
import { AppError } from './errors.js';

export interface EffectiveSettings {
  revision: number;
  adapter: 'mock' | 'pi';
  provider: 'openai';
  model: string;
  responseLanguage: ResponseLanguage;
  apiKey: string | undefined;
}

export type CredentialChecker = (settings: EffectiveSettings) => Promise<CredentialCheck>;
type KeyMode = 'inherit' | 'stored' | 'disabled';
interface SettingsRow {
  owner_id: string;
  revision: number;
  adapter: 'mock' | 'pi';
  provider: 'openai';
  model: string;
  response_language: ResponseLanguage;
  key_mode: KeyMode;
  encrypted_api_key: string | null;
  updated_at: Date | string;
}

function configurationError(): AppError { return new AppError('CONFIGURATION_ERROR', 500); }
function invalid(field?: string): never { throw new AppError('VALIDATION_ERROR', 400, field ? { field } : undefined); }

function decodeBase64(value: string, length?: number): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (length !== undefined && decoded.length !== length)) throw configurationError();
  return decoded;
}

async function encryptionKey(config: ApiConfig): Promise<Buffer> {
  if (config.encryptionKey !== undefined) return decodeBase64(config.encryptionKey, 32);
  const directory = join(config.stateDir, 'configuration');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw configurationError();
  await chmod(directory, 0o700);
  const path = join(directory, 'encryption.key');
  const temporary = join(directory, `encryption-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await file.writeFile(randomBytes(32));
    await file.sync();
  } finally { await file.close(); }
  try { await link(temporary, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { await rm(temporary, { force: true }); }
  const keyFile = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await keyFile.stat();
    if (!info.isFile() || info.size !== 32) throw configurationError();
    await keyFile.chmod(0o600);
    return await keyFile.readFile();
  } finally { await keyFile.close(); }
}

function encrypt(value: string, key: Buffer, ownerId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`nexrun-admin-settings:${ownerId}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

function decrypt(value: string, key: Buffer, ownerId: string): string {
  try {
    const [version, encodedIv, encodedTag, encodedContent, extra] = value.split(':');
    if (version !== 'v1' || !encodedIv || !encodedTag || !encodedContent || extra !== undefined) throw configurationError();
    const decipher = createDecipheriv('aes-256-gcm', key, decodeBase64(encodedIv, 12));
    decipher.setAAD(Buffer.from(`nexrun-admin-settings:${ownerId}`, 'utf8'));
    decipher.setAuthTag(decodeBase64(encodedTag, 16));
    return Buffer.concat([decipher.update(decodeBase64(encodedContent)), decipher.final()]).toString('utf8');
  } catch { throw configurationError(); }
}

async function openAiModels(): Promise<ModelOption[]> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined, list: async () => [],
      modify: async () => { throw configurationError(); }, delete: async () => {},
    },
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  return runtime.getModels('openai').map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id));
}

function parseUpdate(raw: unknown, models: ModelOption[]): AdminSettingsUpdate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const value = raw as Record<string, unknown>;
  const allowed = new Set(['revision', 'adapter', 'provider', 'model', 'responseLanguage', 'keyAction', 'apiKey']);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || Number(value.revision) > 2_147_483_646) invalid('revision');
  if (value.adapter !== 'mock' && value.adapter !== 'pi') invalid('adapter');
  if (value.provider !== 'openai') invalid('provider');
  if (typeof value.model !== 'string' || !models.some((model) => model.id === value.model)) invalid('model');
  if (value.responseLanguage !== 'auto' && value.responseLanguage !== 'en' && value.responseLanguage !== 'zh-CN') invalid('responseLanguage');
  if (typeof value.keyAction !== 'string' || !['keep', 'replace', 'remove', 'inherit'].includes(value.keyAction)) invalid('keyAction');
  if (value.keyAction === 'replace') {
    if (typeof value.apiKey !== 'string' || value.apiKey.length < 16 || value.apiKey.length > 4096 || /[^\x21-\x7e]/.test(value.apiKey)) invalid('apiKey');
  } else if (Object.hasOwn(value, 'apiKey')) invalid('apiKey');
  return {
    revision: Number(value.revision), adapter: value.adapter, provider: 'openai', model: value.model,
    responseLanguage: value.responseLanguage, keyAction: value.keyAction as AdminSettingsUpdate['keyAction'],
    ...(value.keyAction === 'replace' ? { apiKey: value.apiKey as string } : {}),
  };
}

export class SettingsStore {
  private row: SettingsRow | undefined;
  private effective: EffectiveSettings | undefined;
  private masterKey: Buffer | undefined;
  private models: ModelOption[] = [];
  private readonly environmentKey: string | undefined;
  private commitUnknown = false;

  constructor(private readonly pool: Pool, private readonly config: ApiConfig, options: { environment?: NodeJS.ProcessEnv } = {}) {
    const environment = options.environment ?? process.env;
    this.environmentKey = environment.NEXRUN_OPENAI_API_KEY || environment.OPENAI_API_KEY;
  }

  async initialize(): Promise<void> {
    try {
      this.models = await openAiModels();
      this.masterKey = await encryptionKey(this.config);
      let result = await this.pool.query<SettingsRow>('SELECT * FROM admin_settings WHERE owner_id = $1', [this.config.ownerId]);
      if (!result.rowCount || result.rows[0]!.revision === 0) {
        const model = this.config.model ?? 'gpt-5-mini';
        if (!this.models.some((candidate) => candidate.id === model)) throw configurationError();
        if (!result.rowCount) {
          await this.pool.query("INSERT INTO admin_settings (owner_id, adapter, provider, model, response_language, key_mode) VALUES ($1, $2, 'openai', $3, $4, 'inherit') ON CONFLICT (owner_id) DO NOTHING", [this.config.ownerId, this.config.agentMode, model, this.config.responseLanguage]);
        } else {
          // Environment defaults remain authoritative until the first explicit admin save.
          // The revision predicate prevents a concurrent save from being overwritten.
          await this.pool.query("UPDATE admin_settings SET adapter = $2, provider = 'openai', model = $3, response_language = $4, key_mode = 'inherit', encrypted_api_key = NULL, updated_at = clock_timestamp() WHERE owner_id = $1 AND revision = 0", [this.config.ownerId, this.config.agentMode, model, this.config.responseLanguage]);
        }
        result = await this.pool.query<SettingsRow>('SELECT * FROM admin_settings WHERE owner_id = $1', [this.config.ownerId]);
      }
      const row = result.rows[0];
      if (!row) throw configurationError();
      const apiKey = row.key_mode === 'stored' ? decrypt(row.encrypted_api_key!, this.masterKey, this.config.ownerId)
        : row.key_mode === 'inherit' ? this.environmentKey : undefined;
      this.row = row;
      this.effective = { revision: row.revision, adapter: row.adapter, provider: row.provider, model: row.model, responseLanguage: row.response_language, apiKey };
      this.commitUnknown = false;
    } catch { throw configurationError(); }
  }

  getEffective(): EffectiveSettings {
    if (this.commitUnknown) throw new AppError('SETTINGS_COMMIT_UNKNOWN', 503);
    if (!this.effective) throw configurationError();
    return { ...this.effective };
  }

  async getPublic(activeRuns: number): Promise<AdminSettings> {
    const current = this.getEffective();
    const keySource: CredentialSource = !current.apiKey ? 'none' : this.row!.key_mode === 'stored' ? 'stored' : 'environment';
    return {
      revision: current.revision, adapter: current.adapter, provider: current.provider, model: current.model,
      responseLanguage: current.responseLanguage, keyConfigured: Boolean(current.apiKey), keySource,
      environmentKeyAvailable: Boolean(this.environmentKey), updatedAt: new Date(this.row!.updated_at).toISOString(),
      activeRuns, models: this.models.map((model) => ({ ...model })),
    };
  }

  async prepareUpdate(raw: unknown): Promise<AdminSettingsUpdate> {
    this.getEffective();
    return parseUpdate(raw, this.models);
  }

  preview(update: AdminSettingsUpdate): EffectiveSettings {
    const current = this.getEffective();
    const parsed = parseUpdate(update, this.models);
    if (parsed.revision !== current.revision) throw new AppError('SETTINGS_CONFLICT', 409);
    const apiKey = parsed.keyAction === 'replace' ? parsed.apiKey
      : parsed.keyAction === 'remove' ? undefined
      : parsed.keyAction === 'inherit' ? this.environmentKey : current.apiKey;
    return { revision: current.revision + 1, adapter: parsed.adapter, provider: parsed.provider, model: parsed.model, responseLanguage: parsed.responseLanguage, apiKey };
  }

  async update(update: AdminSettingsUpdate): Promise<EffectiveSettings> {
    const parsed = await this.prepareUpdate(update);
    const prospective = this.preview(parsed);
    const previous = this.row!;
    const keyMode = parsed.keyAction === 'replace' ? 'stored' : parsed.keyAction === 'remove' ? 'disabled'
      : parsed.keyAction === 'inherit' ? 'inherit' : previous.key_mode;
    const encryptedKey = parsed.keyAction === 'replace' ? encrypt(parsed.apiKey!, this.masterKey!, this.config.ownerId)
      : parsed.keyAction === 'keep' ? previous.encrypted_api_key : null;
    let saved: SettingsRow;
    try {
      saved = await transaction(this.pool, async (client) => {
        const result = await client.query<SettingsRow>('UPDATE admin_settings SET revision = revision + 1, adapter = $3, provider = $4, model = $5, response_language = $6, key_mode = $7, encrypted_api_key = $8, updated_at = clock_timestamp() WHERE owner_id = $1 AND revision = $2 RETURNING *', [this.config.ownerId, parsed.revision, parsed.adapter, parsed.provider, parsed.model, parsed.responseLanguage, keyMode, encryptedKey]);
        if (!result.rowCount) throw new AppError('SETTINGS_CONFLICT', 409);
        return result.rows[0]!;
      });
    } catch (error) {
      if (error instanceof TransactionCommitUnknownError) {
        this.commitUnknown = true;
        this.effective = undefined;
        this.row = undefined;
        throw new AppError('SETTINGS_COMMIT_UNKNOWN', 503);
      }
      if (error instanceof AppError && error.code === 'SETTINGS_CONFLICT') throw error;
      throw configurationError();
    }
    this.row = saved;
    this.effective = { ...prospective, revision: saved.revision };
    return this.getEffective();
  }
}

export interface AdminRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  ip?: string;
  raw?: { socket?: { remoteAddress?: string } };
}

type AdminConfig = Pick<ApiConfig, 'adminToken' | 'allowedHosts' | 'allowedOrigins'>;
function header(request: AdminRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
function loopback(address: string): boolean {
  const value = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(value) === 4) return value.split('.')[0] === '127';
  if (isIP(value) !== 6) return false;
  try { return new URL(`http://[${value}]`).hostname === '[::1]'; }
  catch { return false; }
}
function localRequest(request: AdminRequest, config: AdminConfig): boolean {
  if (Object.keys(request.headers).some((name) => /^(forwarded|x-forwarded-.+|x-real-ip|via|cf-connecting-ip|true-client-ip|fastly-client-ip)$/i.test(name))) return false;
  const peer = request.ip ?? request.raw?.socket?.remoteAddress;
  if (!peer || !loopback(peer)) return false;
  const host = header(request, 'host');
  if (!host || host !== host.trim() || /[\s/@?#]/.test(host)) return false;
  let hostname: string;
  try { hostname = new URL(`http://${host}`).hostname.toLowerCase(); }
  catch { return false; }
  if (hostname !== 'localhost' && !loopback(hostname.replace(/^\[|\]$/g, ''))) return false;
  if (!config.allowedHosts.some((allowed) => allowed.toLowerCase() === host.toLowerCase() || allowed.toLowerCase() === hostname)) return false;
  const origin = header(request, 'origin');
  const mutates = request.method === 'POST' || request.method === 'PATCH' || request.method === 'PUT' || request.method === 'DELETE';
  if (!origin) return !mutates && !Object.hasOwn(request.headers, 'origin');
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return false;
    if (parsed.hostname !== 'localhost' && !loopback(parsed.hostname.replace(/^\[|\]$/g, ''))) return false;
  } catch { return false; }
  return config.allowedOrigins.includes(origin);
}

export function adminAccess(request: AdminRequest, config: AdminConfig): AdminAccess {
  return { requiresToken: Boolean(config.adminToken), localAccess: localRequest(request, config) };
}

export function authorizeAdmin(request: AdminRequest, config: AdminConfig): AdminAccess {
  const access = adminAccess(request, config);
  if (config.adminToken) {
    const supplied = header(request, 'authorization');
    const match = supplied && !/[\r\n]/.test(supplied) ? /^Bearer ([^\s]+)$/i.exec(supplied) : null;
    const expectedHash = createHash('sha256').update(config.adminToken).digest();
    const suppliedHash = createHash('sha256').update(match?.[1] ?? '').digest();
    if (!match || !timingSafeEqual(expectedHash, suppliedHash)) throw new AppError('ADMIN_AUTH_REQUIRED', 401);
  } else if (!access.localAccess) throw new AppError('ADMIN_ACCESS_DENIED', 403);
  return access;
}

export async function checkOpenAiCredential(settings: EffectiveSettings, fetchImpl: typeof fetch = globalThis.fetch): Promise<CredentialCheck> {
  const result = (code: CredentialCheck['code']): CredentialCheck => ({ ok: code === 'CONNECTION_OK', code, checkedAt: new Date().toISOString(), revision: settings.revision });
  if (!settings.apiKey) return result('AGENT_NOT_CONFIGURED');
  try {
    const signal = AbortSignal.timeout(5_000);
    const response = await fetchImpl(`https://api.openai.com/v1/models/${encodeURIComponent(settings.model)}`, {
      method: 'GET', headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json' },
      redirect: 'error', signal,
    });
    let body: unknown;
    try { body = await response.json(); } catch (error) { if (signal.aborted) throw error; body = undefined; }
    if (response.status === 401 || response.status === 403) return result('UPSTREAM_AUTHENTICATION_FAILED');
    if (response.status === 429) return result('UPSTREAM_RATE_LIMITED');
    if (response.status === 404 || response.status === 400) return result('MODEL_UNAVAILABLE');
    if (!response.ok) return result('UPSTREAM_ERROR');
    if (!body || typeof body !== 'object' || (body as Record<string, unknown>).id !== settings.model) return result('UPSTREAM_ERROR');
    return result('CONNECTION_OK');
  } catch { return result('NETWORK_ERROR'); }
}
