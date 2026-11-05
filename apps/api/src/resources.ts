import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CheckpointManifest, FileToolName, Project, ResourceInput, ResourceItem, ResourceKind,
  ResourceUpdate, Workspace, WorkspaceCheckpoint, WorkspaceDiff, WorkspaceFile,
  WorkspaceLease, WorkspaceSnapshot, WorkspaceWrite,
} from '@nexrun/protocol';
import { transaction } from './db.js';
import { AppError, validation } from './errors.js';

type Db = Pick<PoolClient, 'query'>;
type ProjectRow = { id: string; name: string; archived_at: Date | null; created_at: Date; updated_at: Date };
type WorkspaceRow = ProjectRow & { project_id: string; revision: number; leased_run_id: string | null; fencing_token: number };
type SnapshotRow = { workspace_id: string; revision: number; files: WorkspaceFile[]; content_hash: string; created_at: Date };
type ResourceRow = {
  id: string; kind: ResourceKind; name: string; revision: number; content: string; source: string;
  scope: ResourceItem['scope']; project_id: string | null; workspace_id: string | null;
  required_tools: FileToolName[]; license: string | null; license_evidence: string | null;
  withdrawn_at: Date | null; created_at: Date; updated_at: Date;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const fileTools: FileToolName[] = ['file.list', 'file.read', 'file.search', 'file.write'];
const iso = (value: Date): string => value.toISOString();
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const project = (r: ProjectRow): Project => ({ id: r.id, name: r.name, archivedAt: r.archived_at ? iso(r.archived_at) : null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
const workspace = (r: WorkspaceRow): Workspace => ({ ...project(r), projectId: r.project_id, revision: r.revision, busy: r.leased_run_id !== null });
const snapshot = (r: SnapshotRow): WorkspaceSnapshot => ({ workspaceId: r.workspace_id, revision: r.revision, files: r.files, contentHash: r.content_hash, createdAt: iso(r.created_at) });
const resource = (r: ResourceRow): ResourceItem => ({
  id: r.id, kind: r.kind, name: r.name, revision: r.revision, content: r.content, source: r.source, scope: r.scope,
  projectId: r.project_id, workspaceId: r.workspace_id, requiredTools: r.required_tools, license: r.license,
  licenseEvidence: r.license_evidence, withdrawnAt: r.withdrawn_at ? iso(r.withdrawn_at) : null,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
function identifier(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new AppError(code, 404);
}
function text(value: unknown, maximum: number, field: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') || Buffer.byteLength(value) > maximum) validation({ field, maximum });
  return value;
}
function name(value: unknown): string { return text(value, 240, 'name').trim(); }
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_000_000_000) validation({ field: 'expectedRevision' });
}
export function validateWorkspacePath(value: unknown): string {
  const path = text(value, 240, 'path');
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || /^[A-Za-z]:/.test(path)) validation({ field: 'path' });
  return path;
}
function fileChanges(input: WorkspaceWrite): WorkspaceWrite['files'] {
  revision(input.expectedRevision);
  if (typeof input.operationId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.operationId)) validation({ field: 'operationId' });
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 128) validation({ field: 'files' });
  const seen = new Set<string>();
  return input.files.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(k => !['path', 'content'].includes(k))) validation({ field: 'files' });
    const path = validateWorkspacePath(item.path);
    if (seen.has(path)) validation({ field: 'path' });
    seen.add(path);
    return { path, content: item.content === null ? null : text(item.content, 65_536, 'content', true) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function normalizedResource(kind: ResourceKind, value: ResourceInput): ResourceInput {
  if (!value || typeof value !== 'object') validation();
  const scope = value.scope;
  if (!['user', 'project', 'workspace'].includes(scope)) validation({ field: 'scope' });
  const projectId = value.projectId ?? null;
  const workspaceId = value.workspaceId ?? null;
  if (scope === 'user' && (projectId || workspaceId) || scope === 'project' && (!projectId || workspaceId) || scope === 'workspace' && (!workspaceId || projectId)) validation({ field: 'scope' });
  const requiredTools = value.requiredTools ?? [];
  if (!Array.isArray(requiredTools) || requiredTools.length > 4 || new Set(requiredTools).size !== requiredTools.length || requiredTools.some(t => !fileTools.includes(t))) validation({ field: 'requiredTools' });
  if (kind === 'knowledge' && requiredTools.length) validation({ field: 'requiredTools' });
  const license = value.license === null || value.license === undefined ? null : text(value.license, 200, 'license');
  const licenseEvidence = value.licenseEvidence === null || value.licenseEvidence === undefined ? null : text(value.licenseEvidence, 4000, 'licenseEvidence');
  if (kind === 'skill' && (!license || !licenseEvidence)) validation({ field: 'licenseEvidence' });
  if (kind === 'skill' && !['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'LicenseRef-UserOwned'].includes(license!)) throw new AppError('SKILL_LICENSE_NOT_ADMITTED', 400);
  return { name: name(value.name), content: text(value.content, 32_768, 'content'), source: text(value.source, 2000, 'source'), scope, projectId, workspaceId, requiredTools: [...requiredTools].sort(), license, licenseEvidence };
}
const resourceSelect = `SELECT i.id, i.kind, i.revision, i.withdrawn_at, i.created_at, i.updated_at, r.name, r.content, r.source, r.scope, r.project_id, r.workspace_id, r.required_tools, r.license, r.license_evidence FROM resource_items i JOIN resource_revisions r ON r.resource_id = i.id AND r.revision = i.revision`;

/** PostgreSQL owns immutable file revisions; no caller-provided host path is opened. */
export class ResourceStore {
  constructor(readonly pool: Pool, readonly ownerId: string) {}
  private async use<T>(client: PoolClient | undefined, operation: (db: PoolClient) => Promise<T>): Promise<T> {
    return client ? operation(client) : transaction(this.pool, operation);
  }
  private async projectRow(db: Db, id: string, lock = false): Promise<ProjectRow> {
    identifier(id, 'PROJECT_NOT_FOUND');
    const r = await db.query<ProjectRow>(`SELECT * FROM projects WHERE id = $1 AND owner_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, this.ownerId]);
    if (!r.rows[0]) throw new AppError('PROJECT_NOT_FOUND', 404);
    return r.rows[0];
  }
  private async workspaceRow(db: Db, id: string, lock = false): Promise<WorkspaceRow> {
    identifier(id, 'WORKSPACE_NOT_FOUND');
    const r = await db.query<WorkspaceRow>(`SELECT * FROM workspaces WHERE id = $1 AND owner_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, this.ownerId]);
    if (!r.rows[0]) throw new AppError('WORKSPACE_NOT_FOUND', 404);
    return r.rows[0];
  }
  async listProjects(): Promise<Project[]> {
    const r = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 256', [this.ownerId]);
    return r.rows.map(project);
  }
  async createProject(input: { name: string }): Promise<Project> {
    const r = await this.pool.query<ProjectRow>('INSERT INTO projects(id,owner_id,name) VALUES($1,$2,$3) RETURNING *', [randomUUID(), this.ownerId, name(input.name)]);
    return project(r.rows[0]!);
  }
  async patchProject(id: string, input: { name?: string; archived?: boolean }): Promise<Project> {
    if (input.archived !== undefined && typeof input.archived !== 'boolean') validation();
    return transaction(this.pool, async db => {
      const current = await this.projectRow(db, id, true);
      if (input.archived) {
        const active = await db.query('SELECT 1 FROM workspaces WHERE project_id = $1 AND leased_run_id IS NOT NULL LIMIT 1', [id]);
        if (active.rowCount) throw new AppError('WORKSPACE_BUSY', 409);
      }
      const r = await db.query<ProjectRow>('UPDATE projects SET name=$2,archived_at=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [id, input.name === undefined ? current.name : name(input.name), input.archived === undefined ? current.archived_at : input.archived ? new Date() : null]);
      return project(r.rows[0]!);
    });
  }
  async listWorkspaces(): Promise<Workspace[]> {
    const r = await this.pool.query<WorkspaceRow>('SELECT * FROM workspaces WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 256', [this.ownerId]);
    return r.rows.map(workspace);
  }
  async createWorkspace(input: { name: string; projectId: string }): Promise<Workspace> {
    return transaction(this.pool, async db => {
      const p = await this.projectRow(db, input.projectId, true);
      if (p.archived_at) throw new AppError('PROJECT_ARCHIVED', 409);
      const r = await db.query<WorkspaceRow>('INSERT INTO workspaces(id,owner_id,project_id,name) VALUES($1,$2,$3,$4) RETURNING *', [randomUUID(), this.ownerId, input.projectId, name(input.name)]);
      await db.query('INSERT INTO workspace_revisions(workspace_id,revision,files,content_hash) VALUES($1,0,$2::jsonb,$3)', [r.rows[0]!.id, '[]', hash([])]);
      return workspace(r.rows[0]!);
    });
  }
  async getWorkspace(id: string, client?: PoolClient): Promise<Workspace> { return workspace(await this.workspaceRow(client ?? this.pool, id)); }
  async patchWorkspace(id: string, input: { name?: string; archived?: boolean }): Promise<Workspace> {
    if (input.archived !== undefined && typeof input.archived !== 'boolean') validation();
    return transaction(this.pool, async db => {
      const current = await this.workspaceRow(db, id, true);
      if (current.leased_run_id) throw new AppError('WORKSPACE_BUSY', 409);
      const r = await db.query<WorkspaceRow>('UPDATE workspaces SET name=$2,archived_at=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [id, input.name === undefined ? current.name : name(input.name), input.archived === undefined ? current.archived_at : input.archived ? new Date() : null]);
      return workspace(r.rows[0]!);
    });
  }
  async readRevision(id: string, at?: number, client?: PoolClient): Promise<WorkspaceSnapshot> {
    const db = client ?? this.pool;
    const w = await this.workspaceRow(db, id);
    if (at !== undefined) revision(at);
    const r = await db.query<SnapshotRow>('SELECT * FROM workspace_revisions WHERE workspace_id=$1 AND revision=$2', [id, at ?? w.revision]);
    if (!r.rows[0]) throw new AppError('WORKSPACE_REVISION_NOT_FOUND', 404);
    return snapshot(r.rows[0]);
  }
  async acquireWorkspace(client: PoolClient, id: string, runId: string): Promise<WorkspaceLease> {
    const w = await this.workspaceRow(client, id, true);
    const p = await this.projectRow(client, w.project_id);
    if (w.archived_at || p.archived_at) throw new AppError('WORKSPACE_ARCHIVED', 409);
    const run = await client.query('SELECT 1 FROM runs r JOIN conversations c ON c.id=r.conversation_id WHERE r.id=$1 AND c.owner_id=$2 AND r.status IN (\'queued\',\'running\',\'cancelling\')', [runId, this.ownerId]);
    if (!run.rowCount) throw new AppError('RUN_NOT_FOUND', 404);
    if (w.leased_run_id && w.leased_run_id !== runId) throw new AppError('WORKSPACE_BUSY', 409);
    if (w.leased_run_id !== runId) {
      const r = await client.query<WorkspaceRow>('UPDATE workspaces SET leased_run_id=$2,fencing_token=fencing_token+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [id, runId]);
      return { workspaceId: id, runId, fencingToken: r.rows[0]!.fencing_token, revision: w.revision };
    }
    return { workspaceId: id, runId, fencingToken: w.fencing_token, revision: w.revision };
  }
  async assertLease(client: PoolClient, id: string, runId: string, fencingToken: number): Promise<void> {
    const w = await this.workspaceRow(client, id, true);
    if (w.leased_run_id !== runId || w.fencing_token !== fencingToken) throw new AppError('STALE_EXECUTION', 409);
  }
  async releaseWorkspace(client: PoolClient, id: string, runId: string, fencingToken: number): Promise<void> {
    await this.assertLease(client, id, runId, fencingToken);
    await client.query('UPDATE workspaces SET leased_run_id=NULL,updated_at=clock_timestamp() WHERE id=$1 AND leased_run_id=$2 AND fencing_token=$3', [id, runId, fencingToken]);
  }
  async writeFiles(input: WorkspaceWrite & { workspaceId: string; runId?: string; fencingToken?: number }, client?: PoolClient): Promise<WorkspaceSnapshot> {
    const changes = fileChanges(input);
    const requestHash = hash({ expectedRevision: input.expectedRevision, files: changes, runId: input.runId ?? null, fencingToken: input.fencingToken ?? null });
    return this.use(client, async db => {
      const w = await this.workspaceRow(db, input.workspaceId, true);
      if (w.archived_at || (await this.projectRow(db, w.project_id)).archived_at) throw new AppError('WORKSPACE_ARCHIVED', 409);
      if (input.runId !== undefined) {
        await this.assertLease(db, w.id, input.runId, input.fencingToken ?? -1);
      } else if (input.fencingToken !== undefined) validation({ field: 'fencingToken' });
      const op = await db.query<{ request_hash: string; result_revision: number }>('SELECT request_hash,result_revision FROM workspace_operations WHERE workspace_id=$1 AND operation_id=$2', [w.id, input.operationId]);
      if (op.rows[0]) {
        if (op.rows[0].request_hash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        return this.readRevision(w.id, op.rows[0].result_revision, db);
      }
      if (!input.runId && w.leased_run_id) throw new AppError('WORKSPACE_BUSY', 409);
      if (w.revision !== input.expectedRevision) throw new AppError('WORKSPACE_CONFLICT', 409);
      const old = await this.readRevision(w.id, w.revision, db);
      const files = new Map(old.files.map(f => [f.path, f.content]));
      for (const change of changes) { if (change.content === null) files.delete(change.path); else files.set(change.path, change.content); }
      const nextFiles = [...files].map(([path, content]) => ({ path, content })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      if (nextFiles.length > 128 || Buffer.byteLength(JSON.stringify(nextFiles)) > 524_288) throw new AppError('WORKSPACE_LIMIT', 413);
      const next = w.revision + 1;
      const r = await db.query<SnapshotRow>('INSERT INTO workspace_revisions(workspace_id,revision,files,content_hash) VALUES($1,$2,$3::jsonb,$4) RETURNING *', [w.id, next, JSON.stringify(nextFiles), hash(nextFiles)]);
      await db.query('UPDATE workspaces SET revision=$2,updated_at=clock_timestamp() WHERE id=$1', [w.id, next]);
      await db.query('INSERT INTO workspace_operations(workspace_id,operation_id,request_hash,result_revision,run_id,fencing_token) VALUES($1,$2,$3,$4,$5,$6)', [w.id, input.operationId, requestHash, next, input.runId ?? null, input.fencingToken ?? null]);
      return snapshot(r.rows[0]!);
    });
  }
  async importFiles(input: WorkspaceWrite & { workspaceId: string }, client?: PoolClient): Promise<WorkspaceSnapshot> { return this.writeFiles(input, client); }
  async diff(id: string, from: number, to?: number): Promise<WorkspaceDiff> {
    const before = await this.readRevision(id, from);
    const after = await this.readRevision(id, to);
    const a = new Map(before.files.map(f => [f.path, f.content]));
    const b = new Map(after.files.map(f => [f.path, f.content]));
    const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
    return { workspaceId: id, fromRevision: before.revision, toRevision: after.revision, changes: paths.filter(path => a.get(path) !== b.get(path)).map(path => ({ path, before: a.get(path) ?? null, after: b.get(path) ?? null })) };
  }
  async createCheckpoint(client: PoolClient, input: { workspaceId: string; runId: string; fencingToken: number; manifest: CheckpointManifest }): Promise<WorkspaceCheckpoint> {
    await this.assertLease(client, input.workspaceId, input.runId, input.fencingToken);
    const current = await this.readRevision(input.workspaceId, undefined, client);
    const m = input.manifest;
    if (m.workspaceRevision !== current.revision || !Number.isSafeInteger(m.contextEpoch) || m.contextEpoch < 0 || !Array.isArray(m.resources) || !m.runtimeVersion || !m.adapterVersion || Buffer.byteLength(JSON.stringify(m)) > 65_536) throw new AppError('CHECKPOINT_INVALID', 409);
    const r = await client.query<{ id: string; created_at: Date }>('INSERT INTO workspace_checkpoints(id,workspace_id,run_id,revision,manifest) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,created_at', [randomUUID(), input.workspaceId, input.runId, current.revision, JSON.stringify(m)]);
    return { id: r.rows[0]!.id, workspaceId: input.workspaceId, runId: input.runId, manifest: m, createdAt: iso(r.rows[0]!.created_at) };
  }
  async listCheckpoints(workspaceId: string): Promise<WorkspaceCheckpoint[]> {
    await this.workspaceRow(this.pool, workspaceId);
    const r = await this.pool.query<{ id: string; workspace_id: string; run_id: string; manifest: CheckpointManifest; created_at: Date }>('SELECT * FROM workspace_checkpoints WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50', [workspaceId]);
    return r.rows.map(row => ({ id: row.id, workspaceId: row.workspace_id, runId: row.run_id, manifest: row.manifest, createdAt: iso(row.created_at) }));
  }
  async listResources(kind: ResourceKind): Promise<ResourceItem[]> {
    const r = await this.pool.query<ResourceRow>(`${resourceSelect} WHERE i.owner_id=$1 AND i.kind=$2 ORDER BY i.created_at DESC,i.id DESC LIMIT 256`, [this.ownerId, kind]);
    return r.rows.map(resource);
  }
  async getResource(id: string, kind?: ResourceKind, client?: PoolClient): Promise<ResourceItem> {
    identifier(id, 'RESOURCE_NOT_FOUND');
    const r = await (client ?? this.pool).query<ResourceRow>(`${resourceSelect} WHERE i.id=$1 AND i.owner_id=$2${kind ? ' AND i.kind=$3' : ''}`, kind ? [id, this.ownerId, kind] : [id, this.ownerId]);
    if (!r.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', 404);
    return resource(r.rows[0]);
  }
  private async validateResourceScope(db: PoolClient, input: ResourceInput): Promise<void> {
    if (input.scope === 'project') {
      if ((await this.projectRow(db, input.projectId!)).archived_at) throw new AppError('PROJECT_ARCHIVED', 409);
    } else if (input.scope === 'workspace') {
      const w = await this.workspaceRow(db, input.workspaceId!);
      if (w.archived_at || (await this.projectRow(db, w.project_id)).archived_at) throw new AppError('WORKSPACE_ARCHIVED', 409);
    }
  }
  private async insertResourceRevision(db: PoolClient, id: string, rev: number, input: ResourceInput): Promise<void> {
    await db.query('INSERT INTO resource_revisions(resource_id,revision,name,content,source,scope,project_id,workspace_id,required_tools,license,license_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)', [id, rev, input.name, input.content, input.source, input.scope, input.projectId ?? null, input.workspaceId ?? null, JSON.stringify(input.requiredTools ?? []), input.license ?? null, input.licenseEvidence ?? null]);
  }
  async createResource(kind: ResourceKind, raw: ResourceInput): Promise<ResourceItem> {
    const input = normalizedResource(kind, raw);
    return transaction(this.pool, async db => {
      await this.validateResourceScope(db, input);
      const id = randomUUID();
      await db.query('INSERT INTO resource_items(id,owner_id,kind,revision) VALUES($1,$2,$3,1)', [id, this.ownerId, kind]);
      await this.insertResourceRevision(db, id, 1, input);
      return this.getResource(id, kind, db);
    });
  }
  async updateResource(id: string, kind: ResourceKind, raw: ResourceUpdate): Promise<ResourceItem> {
    const input = normalizedResource(kind, raw);
    revision(raw.expectedRevision);
    if (raw.withdrawn !== undefined && typeof raw.withdrawn !== 'boolean') validation({ field: 'withdrawn' });
    return transaction(this.pool, async db => {
      identifier(id, 'RESOURCE_NOT_FOUND');
      const lock = await db.query<{ revision: number }>('SELECT revision FROM resource_items WHERE id=$1 AND owner_id=$2 AND kind=$3 FOR UPDATE', [id, this.ownerId, kind]);
      if (!lock.rows[0]) throw new AppError('RESOURCE_NOT_FOUND', 404);
      if (lock.rows[0].revision !== raw.expectedRevision) throw new AppError('RESOURCE_CONFLICT', 409);
      const active = await db.query('SELECT 1 FROM agent_bindings b JOIN conversations c ON c.id=b.conversation_id JOIN runs r ON r.conversation_id=b.conversation_id WHERE c.owner_id=$1 AND r.status IN (\'queued\',\'running\',\'cancelling\') AND (b.knowledge_ids::jsonb ? $2 OR b.skill_ids::jsonb ? $2) LIMIT 1', [this.ownerId, id]);
      if (active.rowCount) throw new AppError('RESOURCE_BUSY', 409);
      await this.validateResourceScope(db, input);
      const next = raw.expectedRevision + 1;
      await this.insertResourceRevision(db, id, next, input);
      await db.query('UPDATE resource_items SET revision=$2,withdrawn_at=CASE WHEN $3::boolean IS NULL THEN withdrawn_at WHEN $3 THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1', [id, next, raw.withdrawn ?? null]);
      return this.getResource(id, kind, db);
    });
  }
  async validateBindings(client: PoolClient, knowledgeIds: string[], skillIds: string[], toolNames: string[], workspaceId?: string | null): Promise<ResourceItem[]> {
    if (!Array.isArray(knowledgeIds) || !Array.isArray(skillIds) || knowledgeIds.length > 16 || skillIds.length > 8 || new Set([...knowledgeIds, ...skillIds]).size !== knowledgeIds.length + skillIds.length) validation({ field: 'resources' });
    const w = workspaceId ? await this.workspaceRow(client, workspaceId) : null;
    if (w && (w.archived_at || (await this.projectRow(client, w.project_id)).archived_at)) throw new AppError('WORKSPACE_ARCHIVED', 409);
    const items: ResourceItem[] = [];
    // Lock resource metadata in a stable order so a revision cannot change during admission.
    const ids = [...knowledgeIds, ...skillIds].sort();
    if (ids.length) {
      for (const id of ids) identifier(id, 'RESOURCE_NOT_FOUND');
      await client.query('SELECT id FROM resource_items WHERE id=ANY($1::uuid[]) AND owner_id=$2 ORDER BY id FOR SHARE', [ids, this.ownerId]);
    }
    for (const id of [...knowledgeIds, ...skillIds]) {
      const item = await this.getResource(id, knowledgeIds.includes(id) ? 'knowledge' : 'skill', client);
      if (item.withdrawnAt) throw new AppError('RESOURCE_WITHDRAWN', 409);
      if (item.scope === 'project' && item.projectId !== w?.project_id || item.scope === 'workspace' && item.workspaceId !== w?.id) throw new AppError('RESOURCE_SCOPE_MISMATCH', 403);
      if (item.requiredTools.some(tool => !toolNames.includes(tool))) throw new AppError('SKILL_TOOL_NOT_ALLOWED', 403);
      items.push(item);
    }
    return items;
  }
}
