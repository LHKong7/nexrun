import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import type { AgentBindingInput, AgentProfileInput, RunExecutionSnapshot } from '@nexrun/protocol';
import { loadConfig } from '../src/config.js';
import { migrate, transaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { FoundationStore } from '../src/foundations.js';
import { ResourceStore } from '../src/resources.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://nexrun:nexrun@127.0.0.1:55439/nexrun';
const errorCode = (code: string) => (error: unknown): boolean => error instanceof AppError && error.code === code;
const definition = (change: Partial<AgentProfileInput> = {}): AgentProfileInput => ({ name: 'Developer', instructions: 'Review the selected files.', adapter: 'mock', model: 'gpt-5-mini', responseLanguage: 'en', toolNames: ['file.list', 'file.read', 'file.write'], ...change });
async function fixture(t: TestContext, legacy = false) {
  const schema = `nexrun_foundations_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  let legacyConversation: string | undefined;
  if (legacy) {
    await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
    await pool.query(await readFile(new URL('../migrations/002_admin_settings.sql', import.meta.url), 'utf8'));
    await pool.query('CREATE TABLE nexrun_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('INSERT INTO nexrun_migrations(version) VALUES(1),(2)');
    legacyConversation = randomUUID();
    await pool.query('INSERT INTO conversations(id,owner_id,title) VALUES($1,\'owner\',\'Legacy chat\')', [legacyConversation]);
    await pool.query('INSERT INTO agent_sessions(conversation_id,adapter,native_session_ref,persistence_location,model,provider) VALUES($1,\'pi\',\'original-native-reference\',\'/private/legacy/state\',\'gpt-5-mini\',\'openai\')', [legacyConversation]);
  }
  await migrate(pool);
  const resources = new ResourceStore(pool, 'owner');
  const foundations = new FoundationStore(pool, { ...loadConfig({}), ownerId: 'owner', agentMode: 'mock', responseLanguage: 'en' }, resources);
  return { pool, resources, foundations, legacyConversation };
}
async function conversation(pool: Pool): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,\'owner\')', [id]);
  return id;
}
async function runRow(client: PoolClient, conversationId: string): Promise<string> {
  const id = randomUUID(), userId = randomUUID(), assistantId = randomUUID();
  const order = Number((await client.query('SELECT COALESCE(MAX(order_no),0) AS value FROM messages WHERE conversation_id=$1', [conversationId])).rows[0].value);
  await client.query('INSERT INTO runs(id,conversation_id,user_message_id,assistant_message_id,adapter,status,request_key,request_hash) VALUES($1,$2,$3,$4,\'mock\',\'queued\',$5,\'hash\')', [id, conversationId, userId, assistantId, randomUUID()]);
  await client.query('INSERT INTO messages(id,conversation_id,run_id,role,content,status,order_no) VALUES($1,$2,$3,\'user\',\'Task\',\'completed\',$5),($4,$2,$3,\'assistant\',\'\',\'pending\',$6)', [userId, conversationId, id, assistantId, order + 1, order + 2]);
  return id;
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>, conversationId: string): Promise<{ id: string; snapshot: RunExecutionSnapshot }> {
  return transaction(f.pool, async client => {
    const id = await runRow(client, conversationId);
    return { id, snapshot: await f.foundations.prepareRun(client, conversationId, id) };
  });
}
async function finish(f: Awaited<ReturnType<typeof fixture>>, id: string): Promise<void> {
  await transaction(f.pool, async client => {
    await f.foundations.finish(client, id, 'completed');
    await client.query('UPDATE runs SET status=\'completed\' WHERE id=$1', [id]);
  });
}
function binding(profileId: string | null, expectedContextEpoch: number, extra: Partial<AgentBindingInput> = {}): AgentBindingInput {
  return { profileId, workspaceId: null, knowledgeIds: [], skillIds: [], expectedContextEpoch, ...extra };
}

test('legacy migration preserves native references and assigns an explicit independent identity without inventing a profile', async t => {
  const f = await fixture(t, true);
  const b = await f.foundations.getBinding(f.legacyConversation!);
  assert.equal(b.profileId, null);
  assert.equal(b.contextEpoch, 0);
  assert.ok(b.agentInstanceId);
  const session = (await f.pool.query('SELECT * FROM agent_sessions WHERE conversation_id=$1', [f.legacyConversation])).rows[0];
  assert.equal(session.native_session_ref, 'original-native-reference');
  assert.equal(session.persistence_location, '/private/legacy/state');
  assert.equal(session.agent_instance_id, b.agentInstanceId);
  const epoch = (await f.pool.query('SELECT * FROM agent_session_epochs WHERE conversation_id=$1', [f.legacyConversation])).rows[0];
  assert.equal(epoch.session_key, f.legacyConversation);
  assert.equal(epoch.native_reference, null);
});

test('two chats reuse a profile revision while keeping different instances and native session keys', async t => {
  const f = await fixture(t);
  const profile = await f.foundations.createProfile(definition());
  const a = await conversation(f.pool), b = await conversation(f.pool);
  const ba = await f.foundations.updateBinding(a, binding(profile.id, 0));
  const bb = await f.foundations.updateBinding(b, binding(profile.id, 0));
  assert.notEqual(ba.agentInstanceId, bb.agentInstanceId);
  const first = await prepare(f, a), second = await prepare(f, b);
  assert.notEqual(first.snapshot.sessionKey, second.snapshot.sessionKey);
  assert.equal(first.snapshot.profile!.revision, 1);
  assert.equal(second.snapshot.profile!.id, profile.id);
  const updated = await f.foundations.updateProfile(profile.id, 1, definition({ instructions: 'New profile behavior.' }));
  assert.equal(updated.revision, 2);
  assert.equal((await f.foundations.runtime(a))!.instructions, 'Review the selected files.');
  assert.equal((await f.foundations.runtime(b))!.revision, 1);
  const persisted = (await f.pool.query('SELECT execution_snapshot FROM runs WHERE id=$1', [first.id])).rows[0].execution_snapshot as RunExecutionSnapshot;
  assert.equal(persisted.profile!.revision, 1);
  assert.equal(persisted.roleInstructions, 'Review the selected files.');
  await assert.rejects(f.foundations.updateProfile(profile.id, 1, definition()), errorCode('AGENT_PROFILE_CONFLICT'));
});

test('binding edits reject stale epochs and active Runs, then explicitly start a fresh native context', async t => {
  const f = await fixture(t);
  const profile = await f.foundations.createProfile(definition());
  const id = await conversation(f.pool);
  const first = await f.foundations.updateBinding(id, binding(profile.id, 0));
  await assert.rejects(f.foundations.updateBinding(id, binding(profile.id, 0)), errorCode('AGENT_BINDING_CONFLICT'));
  const accepted = await prepare(f, id);
  await assert.rejects(f.foundations.updateBinding(id, binding(null, first.contextEpoch)), errorCode('CONVERSATION_BUSY'));
  await finish(f, accepted.id);
  const reset = await f.foundations.updateBinding(id, binding(null, first.contextEpoch));
  assert.equal(reset.contextEpoch, first.contextEpoch + 1);
  const next = await prepare(f, id);
  assert.notEqual(next.snapshot.sessionKey, accepted.snapshot.sessionKey);
  assert.equal(next.snapshot.profile, null);
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM agent_session_epochs WHERE conversation_id=$1', [id])).rows[0].count, 3);
});

test('knowledge correction invalidates native context and withdrawn knowledge cannot enter another Run', async t => {
  const f = await fixture(t);
  const profile = await f.foundations.createProfile(definition());
  const id = await conversation(f.pool);
  const input = { name: 'Project decision', content: 'Use the old service.', source: 'Owner decision', scope: 'user' as const };
  const item = await f.resources.createResource('knowledge', input);
  await f.foundations.updateBinding(id, binding(profile.id, 0, { knowledgeIds: [item.id] }));
  const old = await prepare(f, id);
  await finish(f, old.id);
  await f.resources.updateResource(item.id, 'knowledge', { ...input, expectedRevision: 1, content: 'Use the corrected service.' });
  const corrected = await prepare(f, id);
  assert.equal(corrected.snapshot.contextEpoch, old.snapshot.contextEpoch + 1);
  assert.notEqual(corrected.snapshot.sessionKey, old.snapshot.sessionKey);
  assert.ok(corrected.snapshot.resourcesText.includes('Use the corrected service.'));
  assert.ok(!corrected.snapshot.resourcesText.includes('Use the old service.'));
  assert.equal(corrected.snapshot.manifest.sources[0]!.revision, 2);
  await finish(f, corrected.id);
  await f.resources.updateResource(item.id, 'knowledge', { ...input, expectedRevision: 2, content: 'Withdrawn decision.', withdrawn: true });
  await assert.rejects(prepare(f, id), errorCode('RESOURCE_WITHDRAWN'));
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM runs WHERE conversation_id=$1', [id])).rows[0].count, 2);
});

test('cross-chat Workspace use is exclusive and a confirmed external revision starts a new context epoch', async t => {
  const f = await fixture(t);
  const project = await f.resources.createProject({ name: 'Shared project' });
  const workspace = await f.resources.createWorkspace({ name: 'Shared work', projectId: project.id });
  const profile = await f.foundations.createProfile(definition());
  const a = await conversation(f.pool), b = await conversation(f.pool);
  await f.foundations.updateBinding(a, binding(profile.id, 0, { workspaceId: workspace.id }));
  await f.foundations.updateBinding(b, binding(profile.id, 0, { workspaceId: workspace.id }));
  const initial = await prepare(f, a);
  await assert.rejects(prepare(f, b), errorCode('WORKSPACE_BUSY'));
  await finish(f, initial.id);
  const other = await prepare(f, b);
  await f.resources.writeFiles({ workspaceId: workspace.id, expectedRevision: 0, operationId: randomUUID(), runId: other.id, fencingToken: other.snapshot.fencingToken!, files: [{ path: 'notes.txt', content: 'Another chat changed this.' }] });
  await finish(f, other.id);
  const restored = await prepare(f, a);
  assert.equal(restored.snapshot.contextEpoch, initial.snapshot.contextEpoch + 1);
  assert.notEqual(restored.snapshot.sessionKey, initial.snapshot.sessionKey);
  assert.equal(restored.snapshot.workspaceRevision, 1);
  await finish(f, restored.id);
  const ownContinuation = await prepare(f, a);
  assert.equal(ownContinuation.snapshot.contextEpoch, restored.snapshot.contextEpoch);
  assert.equal(ownContinuation.snapshot.sessionKey, restored.snapshot.sessionKey);
});
