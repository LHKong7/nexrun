import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createPiAdapter, piConversationDirectory, piHostEnvironment, reconcilePiHosts, selectedPiApiKey, supervisePiHost, type PiHostRequest,
} from '../src/agents/pi.js';
import { classifyPiDiagnostic, classifyPiError, createTextOnlyResourceLoader, textOnlySessionOptions } from '../src/agents/pi-host.js';

async function withHost(source: string, run: (child: ChildProcess, directory: string) => Promise<void>, marker?: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'nexrun-pi-host-test-'));
  let child: ChildProcess | undefined;
  try {
    const file = join(directory, 'host.cjs');
    await writeFile(file, source);
    child = fork(file, marker ? [`--nexrun-host=${marker}`] : [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: piHostEnvironment('test-only-placeholder') });
    await run(child, directory);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child!.once('close', () => resolve()));
      child.kill('SIGKILL');
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function request(directory: string, timeout = 3_000): PiHostRequest {
  return {
    type: 'generate', conversationId: 'conversation-one', runId: 'run-one', conversationDir: directory,
    prompt: 'Hello', model: 'gpt-5-mini', provider: 'openai', hasPriorHistory: false, generationTimeoutMs: timeout,
  };
}

test('Pi conversation storage uses stable disjoint paths even for path-like IDs', () => {
  const first = piConversationDirectory('/tmp/private-state', '../conversation');
  assert.match(first, /^\/tmp\/private-state\/[a-f0-9]{64}$/);
  assert.equal(first, piConversationDirectory('/tmp/private-state', '../conversation'));
  assert.notEqual(first, piConversationDirectory('/tmp/private-state', 'conversation'));
});

test('Pi host environment contains only the configured provider credential and controlled settings', () => {
  const env = piHostEnvironment('test-only-placeholder');
  assert.deepEqual(Object.keys(env).sort(), ['LANG', 'NODE_ENV', 'OPENAI_API_KEY', 'PI_OFFLINE', 'PI_TELEMETRY', 'TZ']);
  assert.equal(env.PI_TELEMETRY, '0');
  assert.equal(env.PI_OFFLINE, '1');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.HOME, undefined);
});

test('Pi errors never forward upstream text, credential values, or session paths', () => {
  assert.equal(classifyPiError({ status: 429, message: 'private-upstream-content' }), 'UPSTREAM_RATE_LIMITED');
  assert.equal(classifyPiError(new Error('private-upstream-content /private/session.jsonl')), 'UPSTREAM_ERROR');
  assert.equal(classifyPiError({ code: 'UPSTREAM_RATE_LIMITED' }), 'UPSTREAM_RATE_LIMITED');
});

test('Pi host exposes no tools, instructions, extensions, skills or prompt resources', async () => {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const directory = await mkdtemp(join(tmpdir(), 'nexrun-pi-resource-test-'));
  try {
    await writeFile(join(directory, 'AGENTS.md'), 'HOST_INSTRUCTION_MUST_NOT_LOAD');
    const resources = createTextOnlyResourceLoader(sdk.createExtensionRuntime);
    assert.deepEqual(resources.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(resources.getExtensions().extensions, []);
    assert.deepEqual(resources.getSkills().skills, []);
    assert.deepEqual(resources.getPrompts().prompts, []);
    assert.deepEqual(resources.getThemes().themes, []);
    assert.throws(() => resources.extendResources({ skillPaths: [] }), /RESOURCE_LOADING_DISABLED/);
    const options = await textOnlySessionOptions(sdk, directory, directory, sdk.SessionManager.inMemory(directory), 'gpt-5-mini');
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.customTools, []);
    assert.equal(options.noTools, 'all');
    assert.equal(options.settingsManager!.getEnableSkillCommands(), false);
    assert.equal(options.settingsManager!.getCompactionEnabled(), false);
    assert.equal(options.settingsManager!.getRetrySettings().enabled, false);
    assert.equal(options.settingsManager!.getProviderRetrySettings().maxRetries, 0);
    assert.equal(options.settingsManager!.getCacheWarmingMode(), 'off');
    const { session } = await sdk.createAgentSession(options);
    try {
      assert.deepEqual(session.getActiveToolNames(), []);
      assert.doesNotMatch(session.systemPrompt, /HOST_INSTRUCTION_MUST_NOT_LOAD/);
      assert.equal(session.promptTemplates.length, 0);
    } finally { session.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Pi supervisor delivers cumulative text, ignores stale runs, and awaits final persistence', async () => {
  await withHost(`process.on('message', (request) => {
    process.send({type:'ready',runId:request.runId,activeTools:[],resourcesDisabled:true});
    process.send({type:'text',runId:'stale-run',text:'wrong'});
    process.send({type:'text',runId:request.runId,text:'Hel'});
    process.send({type:'text',runId:request.runId,text:'Hello'});
    process.send({type:'done',runId:request.runId,status:'completed'}, () => process.exit(0));
  });`, async (child, directory) => {
    const outputs: string[] = [];
    await supervisePiHost(child, request(directory), new AbortController().signal, async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      outputs.push(text);
    });
    assert.equal(outputs.at(-1), 'Hello');
    assert.ok(outputs.every((text) => 'Hello'.startsWith(text)));
    assert.ok(child.exitCode !== null);
  });
});

test('Pi cancellation waits for termination and ignores text after abort', async () => {
  await withHost(`let runId;
    process.on('message', (request) => {
      if(request.type === 'abort') {
        process.send({type:'text',runId,text:'late-output'});
        process.send({type:'done',runId,status:'cancelled'}, () => process.exit(0));
      } else {
        runId=request.runId;
        process.send({type:'ready',runId,activeTools:[],resourcesDisabled:true});
        process.send({type:'text',runId,text:'Partial'});
      }
    });`, async (child, directory) => {
    const controller = new AbortController();
    const outputs: string[] = [];
    await assert.rejects(supervisePiHost(child, request(directory), controller.signal, async (text) => {
      outputs.push(text); controller.abort();
    }), { name: 'AbortError', message: 'RUN_CANCELLED' });
    assert.deepEqual(outputs, ['Partial']);
    assert.ok(child.exitCode !== null);
  });
});

test('Pi timeout forcibly terminates an unresponsive host', async () => {
  await withHost(`process.on('SIGTERM', () => {}); setInterval(() => {},1000);
    process.on('message', () => {});`, async (child, directory) => {
    await assert.rejects(supervisePiHost(child, request(directory, 20), new AbortController().signal, async () => {}), { message: 'GENERATION_TIMEOUT' });
    assert.equal(child.signalCode, 'SIGKILL');
  });
});

test('Pi supervisor sanitizes host failures and rejects missing completion acknowledgements', async () => {
  await withHost(`process.on('message', (request) => {
    process.send({type:'error',runId:request.runId,code:'unsafe raw provider content'},()=>process.exit(1));
  });`, async (child, directory) => {
    await assert.rejects(supervisePiHost(child, request(directory), new AbortController().signal, async () => {}), { message: 'UPSTREAM_ERROR' });
  });
  await withHost(`process.on('message', () => process.exit(1));`, async (child, directory) => {
    await assert.rejects(supervisePiHost(child, request(directory), new AbortController().signal, async () => {}), { message: 'RUN_INTERRUPTED' });
  });
});

test('Pi rejects endpoint-like model configuration before spawning a host', () => {
  assert.throws(() => createPiAdapter({ stateDir: '/tmp/unused', model: 'https://example.invalid/model' }), { message: 'VALIDATION_ERROR' });
});

test('Pi observed completion is not overwritten by a later abort while the host exits', async () => {
  await withHost(`process.on('message', (request) => {
    process.send({type:'ready',runId:request.runId,activeTools:[],resourcesDisabled:true});
    process.send({type:'text',runId:request.runId,text:'Complete'});
    process.send({type:'done',runId:request.runId,status:'completed'});
    setTimeout(()=>process.exit(0),80);
  });`, async (child, directory) => {
    const controller = new AbortController();
    child.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && (message as Record<string, unknown>).type === 'done') {
        setTimeout(() => controller.abort(), 5);
      }
    });
    await supervisePiHost(child, request(directory), controller.signal, async () => {});
  });
});


test('Pi restart reconciliation stops a recorded host and observes exit before removing its registry', async () => {
  const marker = randomUUID();
  await withHost(`setInterval(() => {}, 1000);`, async (child, directory) => {
    const hosts = join(directory, 'hosts');
    await mkdir(hosts, { mode: 0o700 });
    await writeFile(join(hosts, `${marker}.json`), JSON.stringify({ schemaVersion: 1, pid: child.pid, marker, runId: 'previous-run' }), { mode: 0o600 });
    await reconcilePiHosts(directory);
    assert.deepEqual(await readdir(hosts), []);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }, marker);
});

test('Pi restart reconciliation never kills a reused PID with a different marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexrun-pi-reused-pid-'));
  try {
    const hosts = join(directory, 'hosts');
    const marker = randomUUID();
    await mkdir(hosts, { mode: 0o700 });
    await writeFile(join(hosts, `${marker}.json`), JSON.stringify({ schemaVersion: 1, pid: process.pid, marker, runId: 'previous-run' }), { mode: 0o600 });
    await reconcilePiHosts(directory);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
    assert.deepEqual(await readdir(hosts), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Pi restart reconciliation fails closed for an unreadable host identity record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexrun-pi-invalid-registry-'));
  try {
    const hosts = join(directory, 'hosts');
    await mkdir(hosts, { mode: 0o700 });
    await writeFile(join(hosts, 'invalid.json'), '{}', { mode: 0o600 });
    await assert.rejects(reconcilePiHosts(directory), { code: 'RUN_INTERRUPTED' });
    assert.deepEqual(await readdir(hosts), ['invalid.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('Pi preserves the latest observed partial text before an upstream failure', async () => {
  await withHost(`process.on('message', (request) => {
    if(request.type==='abort') return;
    process.send({type:'ready',runId:request.runId,activeTools:[],resourcesDisabled:true});
    process.send({type:'text',runId:request.runId,text:'Partial'});
    process.send({type:'text',runId:request.runId,text:'Partial response'});
    process.send({type:'error',runId:request.runId,code:'UPSTREAM_RATE_LIMITED'},()=>process.exit(1));
  });`, async (child, directory) => {
    let partial = '';
    await assert.rejects(supervisePiHost(child, request(directory), new AbortController().signal, async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      partial = text;
    }), { code: 'UPSTREAM_RATE_LIMITED' });
    assert.equal(partial, 'Partial response');
  });
});


test('Pi prefers an explicit project key over a generic injected provider key', () => {
  assert.equal(selectedPiApiKey({ NEXRUN_OPENAI_API_KEY: 'project-test-placeholder', OPENAI_API_KEY: 'generic-test-placeholder' }), 'project-test-placeholder');
  assert.equal(selectedPiApiKey({ OPENAI_API_KEY: 'generic-test-placeholder' }), 'generic-test-placeholder');
  assert.equal(selectedPiApiKey({}), undefined);
  assert.equal(piHostEnvironment(selectedPiApiKey({ NEXRUN_OPENAI_API_KEY: 'project-test-placeholder', OPENAI_API_KEY: 'generic-test-placeholder' })!).OPENAI_API_KEY, 'project-test-placeholder');
});

test('Pi exposes only enumerated failure diagnostics without raw authentication responses', () => {
  assert.equal(classifyPiDiagnostic({ status: 401, message: 'private-provider-content' }), 'authentication');
  assert.equal(classifyPiDiagnostic({ message: '401 Incorrect API key provided: test-placeholder' }), 'authentication');
  assert.equal(classifyPiDiagnostic({ message: 'fetch failed' }), 'network');
  assert.equal(classifyPiDiagnostic({ diagnostic: 'private-provider-content' }), 'unknown');
});
