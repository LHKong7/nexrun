import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { AgentBinding, AgentProfile, Project, Run, Workspace, WorkspaceSnapshot } from '@nexrun/protocol';
import { buildApp } from '../apps/api/src/app.js';
import { loadConfig } from '../apps/api/src/config.js';
import { selectedPiApiKey } from '../apps/api/src/agents/pi.js';
import { inspectSandbox } from '../apps/api/src/agents/sandbox.js';

/** Explicitly model-using acceptance: isolated database/state, never prints prompts or keys. */
async function smoke(): Promise<void> {
  if (!selectedPiApiKey()) throw Object.assign(new Error('AGENT_NOT_CONFIGURED'), { code: 'AGENT_NOT_CONFIGURED' });
  await inspectSandbox();
  const config = loadConfig();
  const databaseUrl = process.env.TEST_DATABASE_URL ?? config.databaseUrl;
  const schema = `nexrun_workspace_smoke_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  const stateDir = await mkdtemp(join(tmpdir(), 'nexrun-workspace-smoke-'));
  let pool: Pool | undefined;
  let app: FastifyInstance | undefined;
  let created = false;
  const headers = { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173' };
  async function request<T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object): Promise<T> {
    const response = await app!.inject({ method, url, ...(payload ? { payload } : {}), headers: { ...headers, 'idempotency-key': randomUUID() } });
    if (response.statusCode >= 400) throw Object.assign(new Error('WORKSPACE_SMOKE_FAILED'), { code: response.json<{ error?: { code?: string } }>().error?.code ?? 'WORKSPACE_SMOKE_FAILED' });
    return response.json<T>();
  }
  async function finish(runId: string): Promise<void> {
    const deadline = Date.now() + 130_000;
    while (Date.now() < deadline) {
      const run = await request<Run>('GET', `/api/runs/${runId}`);
      if (run.status === 'completed') return;
      if (['failed', 'cancelled', 'interrupted'].includes(run.status)) throw Object.assign(new Error('WORKSPACE_SMOKE_FAILED'), { code: run.errorCode ?? 'WORKSPACE_SMOKE_FAILED' });
      await delay(100);
    }
    throw Object.assign(new Error('GENERATION_TIMEOUT'), { code: 'GENERATION_TIMEOUT' });
  }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    const options = { pool, config: { ...config, agentMode: 'pi' as const, stateDir, adminToken: undefined, allowedHosts: ['127.0.0.1:3001'], allowedOrigins: ['http://127.0.0.1:5173'] } };
    app = await buildApp(options);
    const profile = await request<AgentProfile>('POST', '/api/agent-profiles', { name: 'Workspace acceptance', instructions: 'Perform the requested file operations using the allowed tools. Preserve unrelated text.', adapter: 'pi', model: config.model ?? 'gpt-5-mini', responseLanguage: 'en', toolNames: ['file.list', 'file.read', 'file.search', 'file.write'] });
    const project = await request<Project>('POST', '/api/projects', { name: 'Workspace acceptance' });
    const workspace = await request<Workspace>('POST', '/api/workspaces', { name: 'Acceptance files', projectId: project.id });
    await request('POST', `/api/workspaces/${workspace.id}/files`, { expectedRevision: 0, operationId: randomUUID(), files: [{ path: 'note.md', content: 'status: pending\n' }] });
    const knowledge = await request<{ id: string }>('POST', '/api/knowledge', { name: 'Desired status', content: 'The required status is completed.', source: 'Repository-authored acceptance fixture', scope: 'workspace', workspaceId: workspace.id });
    const skill = await request<{ id: string }>('POST', '/api/skills', { name: 'Update one file', content: 'Read the target file. Use the returned revision as expectedRevision when writing. Preserve other content.', source: 'Repository-authored acceptance fixture', scope: 'workspace', workspaceId: workspace.id, requiredTools: ['file.read', 'file.write'], license: 'Apache-2.0', licenseEvidence: 'Original NexRun acceptance fixture, covered by the repository LICENSE.' });
    const chat = await request<{ id: string }>('POST', '/api/conversations', {});
    const binding = await request<AgentBinding>('GET', `/api/conversations/${chat.id}/agent-binding`);
    await request('PATCH', `/api/conversations/${chat.id}/agent-binding`, { expectedContextEpoch: binding.contextEpoch, profileId: profile.id, workspaceId: workspace.id, knowledgeIds: [knowledge.id], skillIds: [skill.id] });
    const accepted = await request<{ run: Run }>('POST', `/api/conversations/${chat.id}/messages`, { content: 'Read note.md using the tools, then update its status to the value specified by the selected knowledge. Actually write the file, then reply ACK.' });
    await finish(accepted.run.id);
    const files = await request<WorkspaceSnapshot>('GET', `/api/workspaces/${workspace.id}/files`);
    assert.equal(files.files.find(f => f.path === 'note.md')?.content.trim(), 'status: completed');
    const operations = await request<{ operations: Array<{ name: string }> }>('GET', `/api/runs/${accepted.run.id}/tools`);
    assert.ok(operations.operations.some(o => o.name === 'file.read'));
    assert.ok(operations.operations.some(o => o.name === 'file.write'));
    const checkpoints = await request<{ checkpoints: Array<{ manifest: { workspaceRevision: number; nativeSessionRef: string | null } }> }>('GET', `/api/workspaces/${workspace.id}/checkpoints`);
    assert.equal(checkpoints.checkpoints[0]?.manifest.workspaceRevision, files.revision);
    assert.ok(checkpoints.checkpoints[0]?.manifest.nativeSessionRef?.startsWith('native:'));
    await app.close();
    app = await buildApp(options);
    const restored = await request<WorkspaceSnapshot>('GET', `/api/workspaces/${workspace.id}/files`);
    assert.deepEqual(restored.files, files.files);
    const continued = await request<{ run: Run }>('POST', `/api/conversations/${chat.id}/messages`, { content: 'Read note.md again with the tools. Confirm its stored status, without changing anything.' });
    await finish(continued.run.id);
    console.log(JSON.stringify({ result: 'passed', provider: 'pi', workspaceReadWrite: 'passed', provenance: 'passed', checkpointPair: 'passed', serviceRestart: 'passed', nativeContinuation: 'passed' }));
  } finally {
    await app?.close();
    await pool?.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(stateDir, { recursive: true, force: true });
  }
}

if (process.env.RUN_WORKSPACE_SMOKE !== '1') console.log('Workspace smoke skipped. Set RUN_WORKSPACE_SMOKE=1 to use the configured model.');
else await smoke().catch(error => {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'WORKSPACE_SMOKE_FAILED';
  console.error(JSON.stringify({ result: 'failed', code }));
  process.exitCode = 1;
});
