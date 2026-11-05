import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import { Pool, type PoolClient } from 'pg';
import type { ResourceInput } from '@nexrun/protocol';
import { migrate, transaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { ResourceStore, validateWorkspacePath } from '../src/resources.js';
import { registerResourceRoutes } from '../src/resource-routes.js';
import { AdmissionGate } from '../src/runtime.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://nexrun:nexrun@127.0.0.1:55439/nexrun';
async function fixture(t: TestContext) {
  const schema = `nexrun_resources_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await migrate(pool);
  const store = new ResourceStore(pool, 'owner');
  const project = await store.createProject({ name: 'Example project' });
  const workspace = await store.createWorkspace({ name: 'Example workspace', projectId: project.id });
  return { pool, store, project, workspace };
}
async function seedRun(client: PoolClient): Promise<{ id: string; conversationId: string }> {
  const id = randomUUID(), conversationId = randomUUID(), userId = randomUUID(), assistantId = randomUUID();
  await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,\'owner\')', [conversationId]);
  await client.query('INSERT INTO runs(id,conversation_id,user_message_id,assistant_message_id,adapter,status,request_key,request_hash) VALUES($1,$2,$3,$4,\'mock\',\'running\',$5,\'hash\')', [id, conversationId, userId, assistantId, randomUUID()]);
  await client.query('INSERT INTO messages(id,conversation_id,run_id,role,status,order_no) VALUES($1,$2,$3,\'user\',\'completed\',1),($4,$2,$3,\'assistant\',\'streaming\',2)', [userId, conversationId, id, assistantId]);
  return { id, conversationId };
}
const errorCode = (code: string) => (e: unknown): boolean => e instanceof AppError && e.code === code;
const knowledge = (extra: Partial<ResourceInput> = {}): ResourceInput => ({ name: 'Conventions', content: 'Use explicit revisions.', source: 'Authored for this project', scope: 'user', ...extra });

test('workspace writes preserve immutable revisions, reject stale state, and replay only the identical operation', async t => {
  const { pool, store, workspace } = await fixture(t);
  const operation = { workspaceId: workspace.id, operationId: randomUUID(), expectedRevision: 0, files: [{ path: 'docs/readme.txt', content: 'Initial content' }] };
  const first = await store.importFiles(operation);
  assert.equal(first.revision, 1);
  assert.deepEqual((await store.importFiles(operation)), first);
  await assert.rejects(store.importFiles({ ...operation, files: [{ path: 'docs/readme.txt', content: 'Different content' }] }), errorCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(store.importFiles({ ...operation, operationId: randomUUID() }), errorCode('WORKSPACE_CONFLICT'));
  const second = await store.importFiles({ ...operation, operationId: randomUUID(), expectedRevision: 1, files: [{ path: 'docs/readme.txt', content: 'Edited content' }] });
  assert.equal(second.revision, 2);
  assert.equal((await store.readRevision(workspace.id, 1)).files[0]!.content, 'Initial content');
  assert.deepEqual((await store.diff(workspace.id, 1, 2)).changes, [{ path: 'docs/readme.txt', before: 'Initial content', after: 'Edited content' }]);
  assert.equal((await new ResourceStore(pool, 'owner').readRevision(workspace.id)).contentHash, second.contentHash);
  await assert.rejects(new ResourceStore(pool, 'another-owner').readRevision(workspace.id), errorCode('WORKSPACE_NOT_FOUND'));
});

test('a workspace lease excludes other runs and user writes, then fences its released writer', async t => {
  const { pool, store, workspace } = await fixture(t);
  const first = await transaction(pool, seedRun);
  const second = await transaction(pool, seedRun);
  const lease = await transaction(pool, db => store.acquireWorkspace(db, workspace.id, first.id));
  await assert.rejects(transaction(pool, db => store.acquireWorkspace(db, workspace.id, second.id)), errorCode('WORKSPACE_BUSY'));
  await assert.rejects(store.importFiles({ workspaceId: workspace.id, expectedRevision: 0, operationId: randomUUID(), files: [{ path: 'notes.txt', content: 'User write' }] }), errorCode('WORKSPACE_BUSY'));
  assert.equal((await store.readRevision(workspace.id, 0)).revision, 0);
  const write = { workspaceId: workspace.id, runId: first.id, fencingToken: lease.fencingToken, expectedRevision: 0, operationId: randomUUID(), files: [{ path: 'notes.txt', content: 'Run write' }] };
  await store.writeFiles(write);
  await transaction(pool, db => store.releaseWorkspace(db, workspace.id, first.id, lease.fencingToken));
  const next = await transaction(pool, db => store.acquireWorkspace(db, workspace.id, second.id));
  assert.ok(next.fencingToken > lease.fencingToken);
  await assert.rejects(store.writeFiles({ ...write, operationId: randomUUID(), expectedRevision: 1 }), errorCode('STALE_EXECUTION'));
  await assert.rejects(transaction(pool, db => store.releaseWorkspace(db, workspace.id, first.id, lease.fencingToken)), errorCode('STALE_EXECUTION'));
  assert.equal((await store.getWorkspace(workspace.id)).busy, true);
});

test('scoped resources and declared skill tools cannot cross workspace or capability boundaries', async t => {
  const { pool, store, workspace } = await fixture(t);
  const item = await store.createResource('knowledge', knowledge({ scope: 'workspace', workspaceId: workspace.id }));
  const skill = await store.createResource('skill', knowledge({ name: 'Edit skill', requiredTools: ['file.write'], license: 'Apache-2.0', licenseEvidence: 'Original instructions authored by project owner.' }));
  await assert.rejects(transaction(pool, db => store.validateBindings(db, [item.id], [], [], null)), errorCode('RESOURCE_SCOPE_MISMATCH'));
  await assert.rejects(transaction(pool, db => store.validateBindings(db, [], [skill.id], ['file.read'])), errorCode('SKILL_TOOL_NOT_ALLOWED'));
  assert.equal((await transaction(pool, db => store.validateBindings(db, [item.id], [skill.id], ['file.read', 'file.write'], workspace.id))).length, 2);
  await assert.rejects(store.createResource('skill', knowledge({ requiredTools: ['file.read'] })), errorCode('VALIDATION_ERROR'));
  await assert.rejects(store.createResource('skill', knowledge({ license: 'Unknown', licenseEvidence: 'No upstream license found' })), errorCode('SKILL_LICENSE_NOT_ADMITTED'));
  await assert.rejects(new ResourceStore(pool, 'another-owner').getResource(item.id), errorCode('RESOURCE_NOT_FOUND'));
});

test('resource changes preserve their earlier revision and refuse changes while a bound Run is active', async t => {
  const { pool, store } = await fixture(t);
  const item = await store.createResource('knowledge', knowledge());
  const run = await transaction(pool, seedRun);
  await pool.query('INSERT INTO agent_bindings(conversation_id,agent_instance_id,session_key,knowledge_ids) VALUES($1,$2,$3,$4::jsonb)', [run.conversationId, randomUUID(), randomUUID(), JSON.stringify([item.id])]);
  const change = { ...knowledge(), expectedRevision: 1, content: 'Corrected project conventions.', withdrawn: true };
  await assert.rejects(store.updateResource(item.id, 'knowledge', change), errorCode('RESOURCE_BUSY'));
  await pool.query('UPDATE runs SET status=\'completed\' WHERE id=$1', [run.id]);
  const withdrawn = await store.updateResource(item.id, 'knowledge', change);
  assert.equal(withdrawn.revision, 2);
  assert.ok(withdrawn.withdrawnAt);
  assert.equal((await pool.query('SELECT content FROM resource_revisions WHERE resource_id=$1 AND revision=1', [item.id])).rows[0].content, item.content);
  await assert.rejects(transaction(pool, db => store.validateBindings(db, [item.id], [], [])), errorCode('RESOURCE_WITHDRAWN'));
  await assert.rejects(store.updateResource(item.id, 'knowledge', change), errorCode('RESOURCE_CONFLICT'));
});

test('checkpoints pin a matching durable file revision and native context metadata', async t => {
  const { pool, store, workspace } = await fixture(t);
  const run = await transaction(pool, seedRun);
  const lease = await transaction(pool, db => store.acquireWorkspace(db, workspace.id, run.id));
  const manifest = { workspaceRevision: 0, nativeSessionRef: 'private-native-reference', contextEpoch: 2, profileRevision: 3, resources: [], runtimeVersion: 'test-runtime', adapterVersion: 'test-adapter' };
  await assert.rejects(transaction(pool, db => store.createCheckpoint(db, { workspaceId: workspace.id, runId: run.id, fencingToken: lease.fencingToken, manifest: { ...manifest, workspaceRevision: 1 } })), errorCode('CHECKPOINT_INVALID'));
  const checkpoint = await transaction(pool, db => store.createCheckpoint(db, { workspaceId: workspace.id, runId: run.id, fencingToken: lease.fencingToken, manifest }));
  assert.deepEqual((await store.listCheckpoints(workspace.id))[0], checkpoint);
  assert.equal((await store.readRevision(workspace.id, checkpoint.manifest.workspaceRevision)).revision, 0);
});

test('file import rejects traversal and oversized content without creating a revision', async t => {
  const { store, workspace } = await fixture(t);
  for (const path of ['/etc/passwd', '../escape', 'a/../escape', 'a//b', 'a\\b', 'C:/escape', 'a/']) {
    assert.throws(() => validateWorkspacePath(path), errorCode('VALIDATION_ERROR'));
    await assert.rejects(store.importFiles({ workspaceId: workspace.id, expectedRevision: 0, operationId: randomUUID(), files: [{ path, content: 'bad' }] }), errorCode('VALIDATION_ERROR'));
  }
  await assert.rejects(store.importFiles({ workspaceId: workspace.id, expectedRevision: 0, operationId: randomUUID(), files: [{ path: 'large.txt', content: 'x'.repeat(65_537) }] }), errorCode('VALIDATION_ERROR'));
  assert.equal((await store.getWorkspace(workspace.id)).revision, 0);
});

test('resource routes enforce mutation authorization and reject client-supplied authority', async t => {
  const { store } = await fixture(t);
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => { const known = error instanceof AppError; reply.code(known ? error.statusCode : 500).send({ error: { code: known ? error.code : 'INTERNAL_ERROR' } }); });
  registerResourceRoutes(app, { store, admission: new AdmissionGate(), authorizeMutation(request) { if (request.headers.authorization !== 'Bearer synthetic-admin-token') throw new AppError('ACCESS_DENIED', 403); } });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Denied' } })).statusCode, 403);
  const headers = { authorization: 'Bearer synthetic-admin-token' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Denied', ownerId: 'another-owner' } })).statusCode, 400);
  const created = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Allowed' } });
  assert.equal(created.statusCode, 201, created.body);
  const listed = await app.inject({ method: 'GET', url: '/api/projects' });
  assert.equal(listed.json().projects.length, 2);
});
