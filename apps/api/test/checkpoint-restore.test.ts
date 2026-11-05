import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { migrate, transaction } from '../src/db.js';
import { FoundationStore } from '../src/foundations.js';
import { ResourceStore } from '../src/resources.js';
import { piConversationDirectory } from '../src/agents/pi.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://nexrun:nexrun@127.0.0.1:55439/nexrun';
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

test('native checkpoint restoration preserves real SDK identity and history and rejects mismatched scope', async t => {
  const schema = `nexrun_restore_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'nexrun-checkpoint-restore-')));
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(stateDir, { recursive: true, force: true }); });
  await migrate(pool);
  const config = { ...loadConfig({}), ownerId: 'restore-owner', stateDir, agentMode: 'pi' as const };
  const resources = new ResourceStore(pool, config.ownerId);
  const foundations = new FoundationStore(pool, config, resources);
  const project = await resources.createProject({ name: 'Restore project' });
  const workspace = await resources.createWorkspace({ name: 'Restore workspace', projectId: project.id });
  await resources.importFiles({ workspaceId: workspace.id, expectedRevision: 0, operationId: 'initial-files', files: [{ path: 'guide.txt', content: 'A durable file revision.' }] });
  const conversationId = randomUUID();
  await pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [conversationId, config.ownerId]);
  const profile = await foundations.createProfile({ name: 'Restore profile', instructions: 'Read the selected file.', adapter: 'pi', model: 'gpt-5-mini', responseLanguage: 'en', toolNames: ['file.read'] });
  await foundations.updateBinding(conversationId, { profileId: profile.id, workspaceId: workspace.id, knowledgeIds: [], skillIds: [], expectedContextEpoch: 0 });
  const runId = randomUUID(), userId = randomUUID(), assistantId = randomUUID();
  const snapshot = await transaction(pool, async client => {
    await client.query('INSERT INTO runs(id,conversation_id,user_message_id,assistant_message_id,adapter,status,request_key,request_hash) VALUES($1,$2,$3,$4,\'pi\',\'queued\',\'restore-run\',\'restore-hash\')', [runId, conversationId, userId, assistantId]);
    await client.query('INSERT INTO messages(id,conversation_id,run_id,role,content,status,order_no) VALUES($1,$2,$3,\'user\',\'Restore task\',\'completed\',1),($4,$2,$3,\'assistant\',\'Completed\',\'completed\',2)', [userId, conversationId, runId, assistantId]);
    const snapshot = await foundations.prepareRun(client, conversationId, runId);
    await client.query('UPDATE runs SET status=\'running\',attempt_id=$2 WHERE id=$1', [runId, randomUUID()]);
    return snapshot;
  });
  const directory = piConversationDirectory(stateDir, snapshot.sessionKey);
  const sessionsDir = join(directory, 'sessions'), cwd = join(directory, 'workspace');
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const sdk = await import('@earendil-works/pi-coding-agent');
  const manager = sdk.SessionManager.create(cwd, sessionsDir);
  manager.appendModelChange('openai', 'gpt-5-mini');
  manager.appendMessage({ role: 'user', timestamp: 1, content: 'CHECKPOINT_ORIGINAL_USER_MESSAGE' });
  const liveFile = manager.getSessionFile()!;
  const original = await readFile(liveFile);
  const originalHash = hash(original);
  await foundations.recordNative(runId, { id: manager.getSessionId(), file: liveFile, version: manager.getHeader()!.version, sdkVersion: sdk.VERSION });
  await transaction(pool, async client => {
    await foundations.finish(client, runId, 'completed');
    await client.query('UPDATE runs SET status=\'completed\' WHERE id=$1', [runId]);
  });
  const sealedReference = (await pool.query('SELECT native_reference FROM runs WHERE id=$1', [runId])).rows[0].native_reference;
  assert.equal(hash(await readFile(sealedReference.file)), originalHash);
  assert.equal(sealedReference.sha256, originalHash);

  // Losing the complete live host directory must restore the exact pair, not a new session.
  await rm(directory, { recursive: true, force: true });
  await foundations.restoreNativeCheckpoint(snapshot);
  assert.equal(hash(await readFile(liveFile)), originalHash);
  const manifestPath = join(directory, 'native-session.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.nativeSessionId, manager.getSessionId());
  assert.equal(manifest.nativeSessionFile, liveFile);
  assert.equal(manifest.nativeSessionVersion, manager.getHeader()!.version);
  assert.equal(manifest.conversationId, conversationId);
  const reopened = sdk.SessionManager.open(liveFile, sessionsDir, cwd);
  assert.equal(reopened.getSessionId(), manager.getSessionId());
  assert.equal(reopened.buildSessionContext().messages.length, 1);
  assert.equal(reopened.buildSessionContext().messages[0]!.role, 'user');
  assert.match(JSON.stringify(reopened.buildSessionContext().messages), /CHECKPOINT_ORIGINAL_USER_MESSAGE/);

  await writeFile(manifestPath, '{not valid JSON');
  await foundations.restoreNativeCheckpoint(snapshot);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).nativeSessionId, manager.getSessionId());
  await writeFile(liveFile, original.toString('utf8').replace('CHECKPOINT_ORIGINAL_USER_MESSAGE', 'CORRUPTED_LIVE_USER_MESSAGE'));
  await foundations.restoreNativeCheckpoint(snapshot);
  assert.equal(hash(await readFile(liveFile)), originalHash);

  await assert.rejects(foundations.restoreNativeCheckpoint({ ...snapshot, contextEpoch: snapshot.contextEpoch + 1 }), { code: 'NATIVE_SESSION_UNAVAILABLE' });
  await assert.rejects(foundations.restoreNativeCheckpoint({ ...snapshot, workspaceRevision: snapshot.workspaceRevision! + 1 }), { code: 'NATIVE_SESSION_UNAVAILABLE' });
  assert.equal(hash(await readFile(sealedReference.file)), originalHash);
  await writeFile(sealedReference.file, original.toString('utf8').replace('CHECKPOINT_ORIGINAL_USER_MESSAGE', 'CORRUPTED_SEALED_USER_MESSAGE'));
  await assert.rejects(foundations.restoreNativeCheckpoint(snapshot), { code: 'NATIVE_SESSION_UNAVAILABLE' });
  assert.equal(hash(await readFile(liveFile)), originalHash, 'A corrupt sealed copy must not overwrite the valid live session.');
});
