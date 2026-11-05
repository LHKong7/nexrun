import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { AgentBinding, AgentBindingInput, AgentProfile, AgentProfileInput, FileToolName, RunExecutionSnapshot, ResourceItem } from '@nexrun/protocol';
import type { ApiConfig } from './config.js';
import { AppError, validation } from './errors.js';
import { transaction } from './db.js';
import { ResourceStore } from './resources.js';
import { piConversationDirectory } from './agents/pi.js';

interface BindingRow {
  conversation_id: string; agent_instance_id: string; profile_id: string | null; profile_revision: number | null;
  workspace_id: string | null; knowledge_ids: string[]; skill_ids: string[]; context_epoch: number;
  session_key: string; scope_signature: string | null; last_workspace_revision: number | null;
}
interface ProfileRow { id: string; revision: number; definition: AgentProfileInput; archived_at: Date | null; created_at: Date; updated_at: Date; }
const active = ['queued', 'running', 'cancelling'];
const tools: FileToolName[] = ['file.list', 'file.read', 'file.search', 'file.write'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const profileValue = (r: ProfileRow): AgentProfile => ({ ...r.definition, provider: 'openai', id: r.id, revision: r.revision, archivedAt: r.archived_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() });
const bindingValue = (r: BindingRow): AgentBinding => ({ conversationId: r.conversation_id, agentInstanceId: r.agent_instance_id, profileId: r.profile_id, profileRevision: r.profile_revision, workspaceId: r.workspace_id, knowledgeIds: r.knowledge_ids, skillIds: r.skill_ids, contextEpoch: r.context_epoch });

export function profileInput(value: unknown): AgentProfileInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) validation();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['name', 'instructions', 'adapter', 'provider', 'model', 'responseLanguage', 'toolNames', 'revision', 'archived'].includes(k))) validation();
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 120 || v.name.includes('\0')) validation({ field: 'name' });
  if (typeof v.instructions !== 'string' || v.instructions.length > 12_000 || v.instructions.includes('\0')) validation({ field: 'instructions' });
  if (v.adapter !== 'pi' && v.adapter !== 'mock') validation({ field: 'adapter' });
  if (v.provider !== undefined && v.provider !== 'openai') validation({ field: 'provider' });
  if (typeof v.model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,150}$/.test(v.model)) validation({ field: 'model' });
  if (!['auto', 'en', 'zh-CN'].includes(v.responseLanguage as string)) validation({ field: 'responseLanguage' });
  if (!Array.isArray(v.toolNames) || v.toolNames.length > 4 || new Set(v.toolNames).size !== v.toolNames.length || v.toolNames.some(t => !tools.includes(t as FileToolName))) validation({ field: 'toolNames' });
  return { name: v.name.trim(), instructions: v.instructions, adapter: v.adapter, model: v.model, responseLanguage: v.responseLanguage as AgentProfileInput['responseLanguage'], toolNames: v.toolNames as FileToolName[] };
}

export class FoundationStore {
  constructor(readonly pool: Pool, readonly config: ApiConfig, readonly resources: ResourceStore) {}

  async ensureBinding(client: PoolClient, conversationId: string): Promise<BindingRow> {
    await client.query('INSERT INTO agent_bindings (conversation_id, agent_instance_id, session_key) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING', [conversationId, randomUUID()]);
    const result = await client.query<BindingRow>('SELECT * FROM agent_bindings WHERE conversation_id=$1', [conversationId]);
    const row = result.rows[0]!;
    await client.query('INSERT INTO agent_session_epochs (session_key,conversation_id,agent_instance_id,context_epoch) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [row.session_key, conversationId, row.agent_instance_id, row.context_epoch]);
    return row;
  }

  async listProfiles(): Promise<AgentProfile[]> {
    const rows = await this.pool.query<ProfileRow>('SELECT p.*,r.definition FROM agent_profiles p JOIN agent_profile_revisions r ON r.profile_id=p.id AND r.revision=p.revision WHERE p.owner_id=$1 ORDER BY p.created_at,p.id', [this.config.ownerId]);
    return rows.rows.map(profileValue);
  }

  async getProfile(id: string, client?: PoolClient, revision?: number): Promise<AgentProfile> {
    if (!uuid.test(id)) throw new AppError('AGENT_PROFILE_NOT_FOUND', 404);
    const result = await (client ?? this.pool).query<ProfileRow>('SELECT p.*,r.revision,r.definition FROM agent_profiles p JOIN agent_profile_revisions r ON r.profile_id=p.id AND r.revision=COALESCE($3,p.revision) WHERE p.id=$1 AND p.owner_id=$2', [id, this.config.ownerId, revision ?? null]);
    if (!result.rows[0]) throw new AppError('AGENT_PROFILE_NOT_FOUND', 404);
    return profileValue(result.rows[0]);
  }

  async createProfile(input: AgentProfileInput): Promise<AgentProfile> {
    return transaction(this.pool, async client => {
      const id = randomUUID();
      await client.query('INSERT INTO agent_profiles(id,owner_id) VALUES ($1,$2)', [id, this.config.ownerId]);
      await client.query('INSERT INTO agent_profile_revisions(profile_id,revision,definition) VALUES ($1,1,$2)', [id, input]);
      return this.getProfile(id, client);
    });
  }

  async updateProfile(id: string, revision: number, input: AgentProfileInput, archived?: boolean): Promise<AgentProfile> {
    return transaction(this.pool, async client => {
      const result = await client.query('SELECT id FROM agent_profiles WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, this.config.ownerId]);
      if (!result.rowCount) throw new AppError('AGENT_PROFILE_NOT_FOUND', 404);
      const current = await this.getProfile(id, client);
      if (current.revision !== revision) throw new AppError('AGENT_PROFILE_CONFLICT', 409);
      await client.query('INSERT INTO agent_profile_revisions(profile_id,revision,definition) VALUES ($1,$2,$3)', [id, revision + 1, input]);
      await client.query('UPDATE agent_profiles SET revision=$2,archived_at=$3,updated_at=clock_timestamp() WHERE id=$1', [id, revision + 1, archived === undefined ? current.archivedAt : archived ? new Date() : null]);
      return this.getProfile(id, client);
    });
  }

  private async lockConversation(client: PoolClient, id: string): Promise<void> {
    if (!uuid.test(id)) throw new AppError('CONVERSATION_NOT_FOUND', 404);
    const result = await client.query('SELECT id FROM conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, this.config.ownerId]);
    if (!result.rowCount) throw new AppError('CONVERSATION_NOT_FOUND', 404);
  }

  async getBinding(conversationId: string): Promise<AgentBinding> {
    return transaction(this.pool, async client => { await this.lockConversation(client, conversationId); return bindingValue(await this.ensureBinding(client, conversationId)); });
  }

  async runtime(conversationId: string): Promise<AgentProfile | null> {
    const b = await this.getBinding(conversationId);
    return b.profileId ? this.getProfile(b.profileId, undefined, b.profileRevision!) : null;
  }

  async updateBinding(conversationId: string, raw: unknown): Promise<AgentBinding> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) validation();
    const v = raw as AgentBindingInput;
    if (Object.keys(v).some(k => !['profileId', 'workspaceId', 'knowledgeIds', 'skillIds', 'expectedContextEpoch'].includes(k))) validation();
    if (![v.profileId, v.workspaceId].every(i => i === null || typeof i === 'string' && uuid.test(i))) validation();
    if (![v.knowledgeIds, v.skillIds].every(ids => Array.isArray(ids) && ids.length <= 24 && new Set(ids).size === ids.length && ids.every(i => typeof i === 'string' && uuid.test(i)))) validation();
    if (!Number.isSafeInteger(v.expectedContextEpoch) || v.expectedContextEpoch < 0) validation();
    return transaction(this.pool, async client => {
      await this.lockConversation(client, conversationId);
      const busy = await client.query('SELECT id FROM runs WHERE conversation_id=$1 AND status=ANY($2::text[])', [conversationId, active]);
      if (busy.rowCount) throw new AppError('CONVERSATION_BUSY', 409);
      const row = await this.ensureBinding(client, conversationId);
      if (row.context_epoch !== v.expectedContextEpoch) throw new AppError('AGENT_BINDING_CONFLICT', 409);
      const p = v.profileId ? await this.getProfile(v.profileId, client) : null;
      if (p?.archivedAt) throw new AppError('AGENT_PROFILE_ARCHIVED', 409);
      if (v.workspaceId) await this.resources.getWorkspace(v.workspaceId, client);
      await this.resources.validateBindings(client, v.knowledgeIds, v.skillIds, v.workspaceId ? p?.toolNames ?? [] : [], v.workspaceId);
      await client.query('UPDATE agent_bindings SET profile_id=$2,profile_revision=$3,workspace_id=$4,knowledge_ids=$5,skill_ids=$6 WHERE conversation_id=$1', [conversationId, v.profileId, p?.revision ?? null, v.workspaceId, JSON.stringify(v.knowledgeIds), JSON.stringify(v.skillIds)]);
      return bindingValue(await this.newEpoch(client, await this.ensureBinding(client, conversationId)));
    });
  }

  private async newEpoch(client: PoolClient, row: BindingRow): Promise<BindingRow> {
    const result = await client.query<BindingRow>('UPDATE agent_bindings SET context_epoch=context_epoch+1,session_key=$2,scope_signature=NULL,last_workspace_revision=NULL,updated_at=clock_timestamp() WHERE conversation_id=$1 RETURNING *', [row.conversation_id, randomUUID()]);
    await client.query('DELETE FROM agent_sessions WHERE conversation_id=$1', [row.conversation_id]);
    const next = result.rows[0]!;
    await client.query('INSERT INTO agent_session_epochs(session_key,conversation_id,agent_instance_id,context_epoch) VALUES ($1,$2,$3,$4)', [next.session_key, next.conversation_id, next.agent_instance_id, next.context_epoch]);
    return next;
  }

  async prepareRun(client: PoolClient, conversationId: string, runId: string): Promise<RunExecutionSnapshot> {
    let b = await this.ensureBinding(client, conversationId);
    const profile = b.profile_id ? await this.getProfile(b.profile_id, client, b.profile_revision!) : null;
    const selected: ResourceItem[] = await this.resources.validateBindings(client, b.knowledge_ids, b.skill_ids, b.workspace_id ? profile?.toolNames ?? [] : [], b.workspace_id);
    const lease = b.workspace_id ? await this.resources.acquireWorkspace(client, b.workspace_id, runId) : null;
    const workspace = b.workspace_id ? await this.resources.getWorkspace(b.workspace_id, client) : null;
    const signature = createHash('sha256').update(JSON.stringify({ profile: profile ? [profile.id, profile.revision] : null,
      runtime: [profile?.adapter ?? this.config.agentMode, 'openai', profile?.model ?? this.config.model ?? 'gpt-5-mini'],
      resources: selected.map(r => [r.id, r.revision]), workspace: b.workspace_id })).digest('hex');
    if (b.scope_signature && (b.scope_signature !== signature || workspace && b.last_workspace_revision !== null && b.last_workspace_revision !== workspace.revision)) b = await this.newEpoch(client, b);
    await client.query('UPDATE agent_bindings SET scope_signature=$2 WHERE conversation_id=$1', [conversationId, signature]);
    const snapshot: RunExecutionSnapshot = {
      agentInstanceId: b.agent_instance_id, sessionKey: b.session_key, contextEpoch: b.context_epoch, profile,
      adapter: profile?.adapter ?? this.config.agentMode, provider: 'openai', model: profile?.model ?? this.config.model ?? 'gpt-5-mini',
      responseLanguage: profile?.responseLanguage ?? this.config.responseLanguage, workspaceId: b.workspace_id, workspaceRevision: workspace?.revision ?? null,
      fencingToken: lease?.fencingToken ?? null, toolNames: workspace ? profile?.toolNames ?? [] : [], roleInstructions: profile?.instructions ?? '',
      resourcesText: selected.map(r => JSON.stringify({ kind: r.kind, id: r.id, revision: r.revision, source: r.source, content: r.content })).join('\n'), contextBudget: 96_000,
      manifest: { agentInstanceId: b.agent_instance_id, contextEpoch: b.context_epoch, profileId: b.profile_id, profileRevision: b.profile_revision,
        workspaceId: b.workspace_id, workspaceRevision: workspace?.revision ?? null,
        sources: selected.map(r => ({ id: r.id, revision: r.revision, kind: r.kind, name: r.name, source: r.source })),
        budget: { maximumInputBytes: 96_000, accounting: 'conservative-bytes', includesNativeHistory: true, outputReserve: 4096 }, omissions: [] },
    };
    if (Buffer.byteLength(snapshot.resourcesText + snapshot.roleInstructions) > snapshot.contextBudget / 2) throw new AppError('CONTEXT_LIMIT', 413);
    await client.query('UPDATE runs SET adapter=$2,execution_snapshot=$3,context_manifest=$4 WHERE id=$1', [runId, snapshot.adapter, snapshot, snapshot.manifest]);
    return snapshot;
  }

  async recordNative(runId: string, reference: { id: string; file: string; version: number; sdkVersion: string }): Promise<void> {
    await transaction(this.pool, async client => {
      const result = await client.query<{ execution_snapshot: RunExecutionSnapshot }>("SELECT execution_snapshot FROM runs WHERE id=$1 AND status IN ('running','cancelling') FOR UPDATE", [runId]);
      const snapshot = result.rows[0]?.execution_snapshot;
      if (!snapshot) throw new AppError('RUN_INTERRUPTED', 409);
      await client.query('UPDATE runs SET native_reference=$2 WHERE id=$1', [runId, reference]);
      await client.query('UPDATE agent_session_epochs SET native_reference=$2 WHERE session_key=$1', [snapshot.sessionKey, reference]);
      await client.query('UPDATE agent_sessions SET native_session_ref=$2,persistence_location=$3,runtime_version=$4 WHERE agent_instance_id=$1 AND context_epoch=$5', [snapshot.agentInstanceId, reference.id, reference.file, reference.sdkVersion, snapshot.contextEpoch]);
    });
  }

  /** Restore only the native state paired with this exact durable Workspace/context revision. */
  async restoreNativeCheckpoint(snapshot: RunExecutionSnapshot): Promise<void> {
    if (!snapshot.workspaceId || snapshot.adapter !== 'pi') return;
    const result = await this.pool.query<{ manifest: { contextEpoch: number; workspaceRevision: number }; run_id: string; native_reference: { id: string; file: string; version: number; sdkVersion: string; sha256?: string }; conversation_id: string; live_reference: { file: string } | null }>(
      'SELECT c.manifest,c.run_id,r.native_reference,r.conversation_id,e.native_reference AS live_reference FROM workspace_checkpoints c JOIN runs r ON r.id=c.run_id JOIN agent_session_epochs e ON e.session_key=$2::uuid WHERE c.workspace_id=$1 AND r.execution_snapshot->>\'sessionKey\'=$2::text ORDER BY c.created_at DESC,c.id DESC LIMIT 1', [snapshot.workspaceId, snapshot.sessionKey]);
    const checkpoint = result.rows[0];
    if (!checkpoint) return;
    if (checkpoint.manifest.contextEpoch !== snapshot.contextEpoch || checkpoint.manifest.workspaceRevision !== snapshot.workspaceRevision || !checkpoint.native_reference || !checkpoint.live_reference) throw new AppError('NATIVE_SESSION_UNAVAILABLE', 409);
    const stateRoot = await realpath(this.config.stateDir);
    const directory = piConversationDirectory(stateRoot, snapshot.sessionKey);
    const sessions = join(directory, 'sessions');
    const liveFile = checkpoint.live_reference.file;
    if (dirname(liveFile) !== sessions || !basename(liveFile).endsWith('.jsonl')) throw new AppError('NATIVE_SESSION_UNAVAILABLE', 409);
    const sealed = join(stateRoot, 'checkpoints', `${checkpoint.run_id}.jsonl`);
    if (await realpath(checkpoint.native_reference.file) !== sealed) throw new AppError('NATIVE_SESSION_UNAVAILABLE', 409);
    const saved = await readFile(sealed);
    if (createHash('sha256').update(saved).digest('hex') !== checkpoint.native_reference.sha256) throw new AppError('NATIVE_SESSION_UNAVAILABLE', 409);
    const current = await readFile(liveFile).catch(() => null);
    const manifestPath = join(directory, 'native-session.json');
    const expectedManifest = { schemaVersion: 1, conversationId: checkpoint.conversation_id,
      nativeSessionId: checkpoint.native_reference.id, nativeSessionFile: liveFile, nativeSessionVersion: checkpoint.native_reference.version,
      sdkVersion: checkpoint.native_reference.sdkVersion, provider: snapshot.provider, model: snapshot.model, lastRunId: checkpoint.run_id, state: 'completed' };
    const liveManifest = await readFile(manifestPath, 'utf8').then(text => {
      try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
    }, () => null);
    const manifestMatches = liveManifest && Object.entries(expectedManifest).every(([key, value]) => liveManifest[key] === value);
    if (current?.equals(saved) && manifestMatches) return;
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    const writeAtomic = async (path: string, bytes: Buffer): Promise<void> => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const parent = await open(dirname(path), constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
    };
    await writeAtomic(liveFile, saved);
    await writeAtomic(manifestPath, Buffer.from(JSON.stringify(expectedManifest)));
  }

  async finish(client: PoolClient, runId: string, status: string): Promise<void> {
    const result = await client.query<{ execution_snapshot: RunExecutionSnapshot | null; native_reference: { file: string; sdkVersion: string } | null }>('SELECT execution_snapshot,native_reference FROM runs WHERE id=$1', [runId]);
    const snapshot = result.rows[0]?.execution_snapshot;
    if (!snapshot?.workspaceId) return;
    const workspace = await this.resources.getWorkspace(snapshot.workspaceId, client);
    // Only a settled adapter reaches this hook. Interrupted attempts require a fresh epoch.
    if (status === 'completed' && (snapshot.adapter === 'mock' || result.rows[0]?.native_reference)) {
      const native = result.rows[0]?.native_reference;
      if (native) {
        // A checkpoint must not reference the live JSONL file that a later turn can append to.
        const stateRoot = await realpath(this.config.stateDir);
        const source = await realpath(native.file);
        if (!source.startsWith(`${stateRoot}${sep}`)) throw new AppError('NATIVE_SESSION_UNAVAILABLE', 409);
        const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
          const stat = await input.stat();
          if (!stat.isFile() || stat.size > 8_000_000) throw new AppError('NATIVE_SESSION_UNAVAILABLE', 409);
          bytes = await input.readFile();
        } finally { await input.close(); }
        const directory = join(stateRoot, 'checkpoints');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        const target = join(directory, `${runId}.jsonl`);
        const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { await output.writeFile(bytes); await output.sync(); }
        finally { await output.close(); }
        const parent = await open(directory, constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
        await client.query('UPDATE runs SET native_reference=$2 WHERE id=$1', [runId, { ...native, file: target, sha256: createHash('sha256').update(bytes).digest('hex') }]);
      }
      await this.resources.createCheckpoint(client, { workspaceId: snapshot.workspaceId, runId, fencingToken: snapshot.fencingToken!, manifest: {
        workspaceRevision: workspace.revision, nativeSessionRef: native ? `native:${runId}` : null,
        contextEpoch: snapshot.contextEpoch, profileRevision: snapshot.profile?.revision ?? null,
        resources: snapshot.manifest.sources.map(r => ({ id: r.id, revision: r.revision })), runtimeVersion: 'macos-seatbelt-file-worker-v1', adapterVersion: result.rows[0]?.native_reference?.sdkVersion ?? 'mock-v1',
        ...(snapshot.runtimeIdentity ? { runtimeIdentity: snapshot.runtimeIdentity } : {}),
      } });
      await client.query('UPDATE agent_bindings SET last_workspace_revision=$2 WHERE agent_instance_id=$1 AND context_epoch=$3', [snapshot.agentInstanceId, workspace.revision, snapshot.contextEpoch]);
    } else {
      await client.query("UPDATE agent_bindings SET scope_signature='interrupted' WHERE agent_instance_id=$1", [snapshot.agentInstanceId]);
    }
    await this.resources.releaseWorkspace(client, snapshot.workspaceId, runId, snapshot.fencingToken!);
  }
}
