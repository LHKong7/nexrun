import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { AcceptedMessage, AgentBinding, AgentProfile, ContextManifest, Project, ResourceItem, Run, Workspace, WorkspaceCheckpoint, WorkspaceSnapshot } from '@nexrun/protocol';
import { buildApp, type BuildAppOptions } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AgentAdapter, AgentInput } from '../src/agents/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://nexrun:nexrun@127.0.0.1:55439/nexrun';
const headers = { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173' };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function within<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 8000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t: TestContext, generate: (input: AgentInput, onText: (text: string) => Promise<void>, stateDir: string) => Promise<void>) {
  const schema = `nexrun_execution_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
  const stateDir = await mkdtemp(join(tmpdir(), 'nexrun-execution-'));
  const adapter: AgentAdapter = { mode: 'mock', configured: true, model: 'gpt-5-mini', generate: (input, onText) => generate(input, onText, stateDir) };
  const options: BuildAppOptions = { pool, adapter, reconcileOnStart: false, settingsEnvironment: {}, config: { ...loadConfig({}), stateDir, generationTimeoutMs: 15000, encryptionKey: randomBytes(32).toString('base64') } };
  const f = {
    app: undefined as unknown as FastifyInstance, pool, stateDir, options,
    request: (input: InjectOptions) => f.app.inject({ ...input, headers: { ...headers, ...input.headers } }),
  };
  t.after(async () => { await f.app?.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(stateDir, { recursive: true, force: true }); });
  f.app = await buildApp(options);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function post<T>(f: Fixture, url: string, payload: object): Promise<T> {
  const result = await f.request({ method: 'POST', url, payload });
  assert.equal(result.statusCode, 201, result.body);
  return result.json<T>();
}
async function workspaceSetup(f: Fixture) {
  const project = await post<Project>(f, '/api/projects', { name: 'Execution project' });
  const workspace = await post<Workspace>(f, '/api/workspaces', { name: 'Execution files', projectId: project.id });
  const imported = await f.request({ method: 'POST', url: `/api/workspaces/${workspace.id}/files`, payload: { expectedRevision: 0, operationId: randomUUID(), files: [{ path: 'guide.txt', content: 'Initial workspace text.' }, { path: '.gitignore', content: 'node_modules/' }] } });
  assert.equal(imported.statusCode, 200, imported.body);
  const profile = await post<AgentProfile>(f, '/api/agent-profiles', { name: 'Synthetic file editor', instructions: 'Inspect and update the authorized text files.', adapter: 'mock', model: 'gpt-5-mini', responseLanguage: 'en', toolNames: ['file.list', 'file.read', 'file.write'] });
  return { project, workspace, profile };
}
async function bindChat(f: Fixture, profileId: string, workspaceId: string, knowledgeIds: string[] = [], skillIds: string[] = []): Promise<AgentBinding> {
  const conversation = await post<{ id: string }>(f, '/api/conversations', {});
  const response = await f.request({ method: 'PATCH', url: `/api/conversations/${conversation.id}/agent-binding`, payload: { profileId, workspaceId, knowledgeIds, skillIds, expectedContextEpoch: 0 } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function send(f: Fixture, conversationId: string, content: string) {
  return f.request({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: { 'idempotency-key': randomUUID() }, payload: { content } });
}
async function terminal(f: Fixture, runId: string): Promise<Run> {
  return within((async () => {
    for (;;) {
      const response = await f.request({ method: 'GET', url: `/api/runs/${runId}` });
      assert.equal(response.statusCode, 200, response.body);
      const run = response.json<Run>();
      if (!['queued', 'running', 'cancelling'].includes(run.status)) return run;
      await delay(10);
    }
  })(), 'the execution terminal state');
}

// Synthetic Agent decisions are injected; file operations use the actual OS-enforced worker.
test('API workspace execution persists one idempotent edit, source manifests, operation results and immutable native checkpoints', async t => {
  let observed: AgentInput | undefined;
  let nativePath = '';
  const f = await fixture(t, async (input, onText, stateDir) => {
    observed = input;
    assert.ok(input.toolExecutor);
    const read = await input.toolExecutor({ id: 'read-guide', name: 'file.read', args: { path: 'guide.txt' } }) as { revision: number; result: { content: string } };
    assert.equal(read.result.content, 'Initial workspace text.');
    const operation = { id: 'write-guide', name: 'file.write' as const, args: { path: 'guide.txt', content: 'Updated by the synthetic Agent.', expectedRevision: read.revision } };
    const written = await input.toolExecutor(operation);
    assert.deepEqual(await input.toolExecutor(operation), written);
    await assert.rejects(input.toolExecutor({ ...operation, args: { ...operation.args, content: 'Conflicting replay.' } }), { code: 'IDEMPOTENCY_CONFLICT' });
    nativePath = join(stateDir, 'synthetic-session.jsonl');
    await writeFile(nativePath, '{"synthetic":"original native state"}\n', { mode: 0o600 });
    await input.onNativeSession!({ id: 'synthetic-native-id', file: nativePath, version: 1, sdkVersion: 'synthetic-sdk-v1' });
    await onText('Synthetic file update complete.');
  });
  const { workspace, profile } = await workspaceSetup(f);
  const knowledge = await post<ResourceItem>(f, '/api/knowledge', { name: 'Project language', content: 'Project prose uses English.', source: 'Owner-authored project decision', scope: 'workspace', workspaceId: workspace.id });
  const skill = await post<ResourceItem>(f, '/api/skills', { name: 'Careful text edit', content: 'Read the file before editing it.', source: 'Owner-authored workflow', scope: 'user', requiredTools: ['file.read', 'file.write'], license: 'LicenseRef-UserOwned', licenseEvidence: 'Original instructions authored by this test fixture.' });
  const binding = await bindChat(f, profile.id, workspace.id, [knowledge.id], [skill.id]);
  const accepted = await send(f, binding.conversationId, 'Inspect and update the guide.');
  assert.equal(accepted.statusCode, 202, accepted.body);
  const run = accepted.json<AcceptedMessage>().run;
  const settled = await terminal(f, run.id);
  if (process.platform !== 'darwin') {
    assert.equal(settled.status, 'failed'); assert.equal(settled.errorCode, 'SANDBOX_UNAVAILABLE'); return;
  }
  assert.equal(settled.status, 'completed', JSON.stringify(settled));
  assert.ok(observed?.execution?.resourcesText.includes(knowledge.content));
  assert.ok(observed?.execution?.resourcesText.includes(skill.content));
  const files = (await f.request({ method: 'GET', url: `/api/workspaces/${workspace.id}/files` })).json<WorkspaceSnapshot>();
  assert.equal(files.revision, 2);
  assert.equal(files.files.find(file => file.path === 'guide.txt')!.content, 'Updated by the synthetic Agent.');
  const manifest = (await f.request({ method: 'GET', url: `/api/runs/${run.id}/context` })).json<ContextManifest>();
  assert.equal(manifest.agentInstanceId, binding.agentInstanceId);
  assert.deepEqual(manifest.sources.map(source => [source.id, source.revision]), [[knowledge.id, 1], [skill.id, 1]]);
  assert.equal(manifest.budget.includesNativeHistory, true);
  const ledger = (await f.request({ method: 'GET', url: `/api/runs/${run.id}/tools` })).json<{ operations: Array<{ id: string; result: { revision: number } }> }>();
  assert.equal(ledger.operations.length, 2);
  assert.equal(ledger.operations.find(operation => operation.id === 'write-guide')!.result.revision, 2);
  const checkpoint = (await f.request({ method: 'GET', url: `/api/workspaces/${workspace.id}/checkpoints` })).json<{ checkpoints: WorkspaceCheckpoint[] }>().checkpoints[0]!;
  assert.equal(checkpoint.manifest.workspaceRevision, 2);
  assert.equal(checkpoint.manifest.nativeSessionRef, `native:${run.id}`);
  assert.ok(!JSON.stringify(checkpoint).includes(nativePath));
  const sealed = (await f.pool.query('SELECT native_reference FROM runs WHERE id=$1', [run.id])).rows[0].native_reference.file as string;
  const original = await readFile(sealed, 'utf8');
  await appendFile(nativePath, '{"synthetic":"later turn"}\n');
  assert.equal(await readFile(sealed, 'utf8'), original);
  assert.notEqual(await readFile(nativePath, 'utf8'), original);
  await f.app.close();
  f.app = await buildApp(f.options);
  assert.deepEqual((await f.request({ method: 'GET', url: `/api/workspaces/${workspace.id}/files?revision=2` })).json(), files);
  assert.equal((await readFile(sealed, 'utf8')), original);
});

/** Hold one real operation immediately before its ledger insert, without mocking its sandbox. */
function holdOperationCommit(pool: Pool, operationId: string, entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>): void {
  const originalConnect = pool.connect.bind(pool);
  const wrap = (client: any) => {
    const originalQuery = client.query;
    const originalRelease = client.release;
    client.query = function (...args: any[]) {
      if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO run_tool_operations') && args[1]?.[1] === operationId) {
        entered.resolve();
        return within(release.promise, 'the held tool transaction release').then(() => Reflect.apply(originalQuery, this, args));
      }
      return Reflect.apply(originalQuery, this, args);
    };
    client.release = function (...args: any[]) { client.query = originalQuery; client.release = originalRelease; return Reflect.apply(originalRelease, this, args); };
    return client;
  };
  pool.connect = ((callback?: (error: unknown, client?: unknown, done?: unknown) => void) => {
    const connected = originalConnect().then(wrap);
    if (!callback) return connected;
    void connected.then(client => callback(null, client, client.release), error => callback(error));
  }) as typeof pool.connect;
}

test('workspace cancellation retains the lease until the real tool and Agent settle and stale callbacks cannot write', async t => {
  const toolEntered = deferred(), toolRelease = deferred(), adapterExit = deferred(), aborted = deferred();
  let oldExecutor: AgentInput['toolExecutor'];
  const f = await fixture(t, async (input, onText) => {
    if (input.prompt !== 'Hold this execution.') { await onText('Serial use succeeded.'); return; }
    oldExecutor = input.toolExecutor;
    const signalAborted = new Promise<void>(resolve => {
      if (input.signal.aborted) { aborted.resolve(); resolve(); }
      else input.signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true });
    });
    await input.toolExecutor!({ id: 'held-read', name: 'file.read', args: { path: 'guide.txt' } });
    await within(signalAborted, 'the cancellation signal');
    await within(adapterExit.promise, 'the synthetic Agent termination');
    throw Object.assign(new Error('Observed cancellation.'), { name: 'AbortError' });
  });
  const { workspace, profile } = await workspaceSetup(f);
  const first = await bindChat(f, profile.id, workspace.id);
  const second = await bindChat(f, profile.id, workspace.id);
  holdOperationCommit(f.pool, 'held-read', toolEntered, toolRelease);
  const accepted = await send(f, first.conversationId, 'Hold this execution.');
  assert.equal(accepted.statusCode, 202, accepted.body);
  const run = accepted.json<AcceptedMessage>().run;
  if (process.platform !== 'darwin') {
    const settled = await terminal(f, run.id); assert.equal(settled.errorCode, 'SANDBOX_UNAVAILABLE'); return;
  }
  await within(toolEntered.promise, 'the real sandboxed read');
  const blockedRequest = send(f, second.conversationId, 'Serial use.');
  let cancellationReturned = false;
  const cancelRequest = f.request({ method: 'POST', url: `/api/runs/${run.id}/cancel` }).then(response => { cancellationReturned = true; return response; });
  await delay(20);
  assert.equal(cancellationReturned, false);
  assert.equal((await f.request({ method: 'GET', url: `/api/workspaces/${workspace.id}` })).json<Workspace>().busy, true);
  // The real tool still holds its run/workspace rows until the ledger outcome is durable.
  toolRelease.resolve();
  const [blocked, cancel] = await Promise.all([blockedRequest, cancelRequest]);
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error.code, 'WORKSPACE_BUSY');
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json<Run>().status, 'cancelling');
  await within(aborted.promise, 'the synthetic Agent abort acknowledgement');
  assert.equal((await f.request({ method: 'GET', url: `/api/workspaces/${workspace.id}` })).json<Workspace>().busy, true);
  assert.equal((await f.request({ method: 'GET', url: `/api/runs/${run.id}` })).json<Run>().status, 'cancelling');
  adapterExit.resolve();
  assert.equal((await terminal(f, run.id)).status, 'cancelled');
  const lateWrite = { id: 'stale-write', name: 'file.write' as const, args: { path: 'guide.txt', content: 'Must never appear.', expectedRevision: 1 } };
  await assert.rejects(oldExecutor!(lateWrite), { name: 'AbortError' });
  const current = (await f.request({ method: 'GET', url: `/api/workspaces/${workspace.id}/files` })).json<WorkspaceSnapshot>();
  assert.equal(current.revision, 1);
  assert.equal(current.files.find(file => file.path === 'guide.txt')!.content, 'Initial workspace text.');
  const serial = await send(f, second.conversationId, 'Serial use.');
  assert.equal(serial.statusCode, 202, serial.body);
  assert.equal((await terminal(f, serial.json<AcceptedMessage>().run.id)).status, 'completed');
});
