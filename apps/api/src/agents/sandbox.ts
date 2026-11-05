import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileToolName } from '@nexrun/protocol';

export interface SandboxFile { path: string; content: string }
export interface WorkspaceOperation { id: string; name: FileToolName; args: Record<string, unknown> }
export interface SandboxResult { result: unknown; files: SandboxFile[] }
export interface SandboxEvidence { provider: 'macos-seatbelt'; networkDenied: boolean; hostReadDenied: boolean; dataAliasReadDenied: boolean; symlinkReadDenied: boolean; hostWriteDenied: boolean; subprocessDenied: boolean }
export interface NativeRuntimeIdentity { nodeVersion: string; osVersion: string; osBuild: string; nodeSha256: string; sandboxSha256: string; policySha256: string }

export class SandboxError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SandboxError'; }
}

/** Only directories and OS runtime files are readable. No content is executed. */
export function seatbeltProfile(nodePath: string): string {
  if (!nodePath.startsWith('/') || /[\r\n\0]/.test(nodePath)) throw new SandboxError('SANDBOX_UNAVAILABLE');
  const literal = JSON.stringify(nodePath);
  return `(version 1)\n(deny default)\n(allow process-exec (literal ${literal}))\n(allow file-read-metadata)\n(allow file-read-data (require-any (vnode-type DIRECTORY) (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/share") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/zero")))\n(allow sysctl-read)\n(allow mach-lookup)\n`;
}

const maxBytes = 2_000_000;
const admittedNodeSha256 = '49161ba4e67afda85c25b2daa1f0e91d1bffc023d2dbc4886eda7a9ba38bca62';
const admittedSandboxSha256 = '8857d087219f0f39d3e3c163e5d0a0aed690cc22f34b50c7eee3d74f93e69688';
let identity: Promise<NativeRuntimeIdentity> | undefined;

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** A new installed binary needs an exact-release review before workspace admission. */
export function nativeRuntimeIdentity(): Promise<NativeRuntimeIdentity> {
  identity ??= (async () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.version !== 'v22.20.0') throw new SandboxError('SANDBOX_UNAVAILABLE');
    const system = await readFile('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
    const osVersion = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(system)?.[1];
    const osBuild = /<key>ProductBuildVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(system)?.[1];
    if (osVersion !== '26.5.1' || osBuild !== '25F80') throw new SandboxError('SANDBOX_UNAVAILABLE');
    const nodePath = await realpath(process.execPath);
    const [nodeSha256, sandboxSha256] = await Promise.all([fileHash(nodePath), fileHash('/usr/bin/sandbox-exec')]);
    if (nodeSha256 !== admittedNodeSha256 || sandboxSha256 !== admittedSandboxSha256) throw new SandboxError('SANDBOX_UNAVAILABLE');
    return { nodeVersion: process.version.slice(1), osVersion, osBuild, nodeSha256, sandboxSha256, policySha256: createHash('sha256').update(seatbeltProfile(nodePath)).digest('hex') };
  })().catch(() => { identity = undefined; throw new SandboxError('SANDBOX_UNAVAILABLE'); });
  return identity;
}

/** The caller cannot provide JavaScript: both programs below are platform-owned constants. */
async function runWorker(program: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  if (process.platform !== 'darwin') throw new SandboxError('SANDBOX_UNAVAILABLE');
  if (signal?.aborted) throw Object.assign(new Error('RUN_CANCELLED'), { name: 'AbortError' });
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > maxBytes) throw new SandboxError('WORKSPACE_LIMIT');
  const nodePath = await realpath(process.execPath);
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', seatbeltProfile(nodePath), nodePath, '--max-old-space-size=64', '--stack_size=512', '--input-type=commonjs', '-e', program], {
      cwd: tmpdir(), env: { LANG: 'C.UTF-8', TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let bytes = 0;
    let error: Error | undefined;
    const abort = (): void => { error ??= Object.assign(new Error('RUN_CANCELLED'), { name: 'AbortError' }); child.kill('SIGKILL'); };
    const timeout = setTimeout(() => { error ??= new SandboxError('SANDBOX_TIMEOUT'); child.kill('SIGKILL'); }, 5_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) { error ??= new SandboxError('WORKSPACE_LIMIT'); child.kill('SIGKILL'); }
      else output += chunk;
    });
    // Native diagnostics may contain host paths; never publish them as API errors.
    child.stderr.resume();
    child.once('error', () => { error ??= new SandboxError('SANDBOX_UNAVAILABLE'); });
    child.stdin.on('error', () => { error ??= new SandboxError('SANDBOX_UNAVAILABLE'); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) { rejectResult(error); return; }
      if (code !== 0) { rejectResult(new SandboxError('SANDBOX_UNAVAILABLE')); return; }
      try {
        const parsed = JSON.parse(output) as { error?: string };
        if (parsed.error) rejectResult(new SandboxError(parsed.error));
        else resolveResult(parsed);
      } catch { rejectResult(new SandboxError('SANDBOX_UNAVAILABLE')); }
    });
    child.stdin.end(payload);
  });
}

const probe = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const denied = (fn) => { try { fn(); return false; } catch (e) { return e.code === 'EPERM' || e.code === 'EACCES'; } };
const hostReadDenied = denied(() => fs.readFileSync(input.path));
const dataAliasReadDenied = denied(() => fs.readFileSync(input.alias));
const symlinkReadDenied = denied(() => fs.readFileSync(input.link));
const hostWriteDenied = denied(() => fs.writeFileSync('/private/tmp/nexrun-seatbelt-denial-probe', 'denied', {flag:'wx'}));
const subprocessDenied = !!cp.spawnSync('/usr/bin/true').error;
const socket = net.connect({host:'127.0.0.1',port:9});
socket.once('error', e => { process.stdout.write(JSON.stringify({provider:'macos-seatbelt',hostReadDenied,dataAliasReadDenied,symlinkReadDenied,hostWriteDenied,subprocessDenied,networkDenied:e.code==='EPERM'||e.code==='EACCES'})); });
socket.once('connect', () => { socket.destroy(); process.stdout.write(JSON.stringify({provider:'macos-seatbelt',hostReadDenied,dataAliasReadDenied,symlinkReadDenied,hostWriteDenied,subprocessDenied,networkDenied:false})); });
`;

let readiness: Promise<SandboxEvidence> | undefined;
export async function inspectSandbox(): Promise<SandboxEvidence> {
  if (process.platform !== 'darwin') throw new SandboxError('SANDBOX_UNAVAILABLE');
  await nativeRuntimeIdentity();
  const directory = await mkdtemp(join(tmpdir(), 'nexrun-seatbelt-probe-'));
  try {
    const path = join(await realpath(directory), 'sentinel.txt');
    const link = join(directory, 'link.txt');
    await writeFile(path, 'NexRun native sandbox denial probe', { mode: 0o600 });
    await symlink(path, link);
    const evidence = await runWorker(probe, { path, alias: `/System/Volumes/Data${path}`, link }) as SandboxEvidence;
    if (evidence.provider !== 'macos-seatbelt' || !evidence.networkDenied || !evidence.hostReadDenied || !evidence.dataAliasReadDenied || !evidence.symlinkReadDenied || !evidence.hostWriteDenied || !evidence.subprocessDenied) throw new SandboxError('SANDBOX_UNAVAILABLE');
    return evidence;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function ensureSandbox(): Promise<SandboxEvidence> {
  readiness ??= inspectSandbox().catch(error => { readiness = undefined; throw error; });
  return readiness;
}

const fileWorker = String.raw`
let raw='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw)>2000000) process.exit(1); });
process.stdin.on('end', () => {
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  try {
    const {files,operation}=JSON.parse(raw);
    const path=p=>{if(typeof p!=='string'||!p.trim()||Buffer.byteLength(p)>240||p.includes('\\')||p.includes('\0')||p.startsWith('/')||p.split('/').some(s=>!s||s==='.'||s==='..')||/^[A-Za-z]:/.test(p))fail('WORKSPACE_PATH_INVALID');return p;};
    if(!Array.isArray(files)||files.length>128||Buffer.byteLength(JSON.stringify(files))>524288)fail('WORKSPACE_LIMIT');
    const entries=new Map();
    let total=0;
    for(const file of files){const p=path(file.path);if(typeof file.content!=='string'||file.content.includes('\0')||Buffer.byteLength(file.content)>65536||entries.has(p))fail('WORKSPACE_LIMIT');total+=Buffer.byteLength(file.content);entries.set(p,file.content);}
    if(total>524288||!operation||typeof operation.id!=='string'||operation.id.length>200||!operation.args||typeof operation.args!=='object'||Array.isArray(operation.args))fail('WORKSPACE_LIMIT');
    const args=operation.args;
    let result;
    if(operation.name==='file.list'){
      const prefix=args.prefix===undefined?'':path(args.prefix);
      result={paths:[...entries.keys()].filter(p=>p.startsWith(prefix)).sort()};
    }else if(operation.name==='file.read'){
      const p=path(args.path);if(!entries.has(p))fail('WORKSPACE_FILE_NOT_FOUND');
      const content=entries.get(p);if(Buffer.byteLength(content)>32000)fail('WORKSPACE_RESULT_LIMIT');result={path:p,content};
    }else if(operation.name==='file.search'){
      if(typeof args.query!=='string'||!args.query||args.query.length>200)fail('VALIDATION_ERROR');
      const selected=args.path===undefined?undefined:path(args.path);const matches=[];
      for(const [p,content]of entries){if(selected!==undefined&&p!==selected)continue;const lines=content.split('\n');for(let i=0;i<lines.length&&matches.length<100;i++){if(lines[i].includes(args.query))matches.push({path:p,line:i+1,text:lines[i].slice(0,500)});}}
      result={matches};
    }else if(operation.name==='file.write'){
      const p=path(args.path);if(typeof args.content!=='string'||args.content.includes('\0')||Buffer.byteLength(args.content)>65536||!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision<0)fail('VALIDATION_ERROR');
      entries.set(p,args.content);result={path:p,written:true,expectedRevision:args.expectedRevision};
    }else fail('TOOL_NOT_ALLOWED');
    const output={result,files:[...entries].sort(([a],[b])=>a.localeCompare(b)).map(([path,content])=>({path,content}))};
    if(output.files.length>128||Buffer.byteLength(JSON.stringify(output.files))>524288)fail('WORKSPACE_LIMIT');
    if(Buffer.byteLength(JSON.stringify(result))>64000||Buffer.byteLength(JSON.stringify(output))>2000000)fail('WORKSPACE_RESULT_LIMIT');
    process.stdout.write(JSON.stringify(output));
  }catch(e){process.stdout.write(JSON.stringify({error:typeof e.code==='string'?e.code:'VALIDATION_ERROR'}));}
});
`;

export async function executeSandboxedOperation(files: SandboxFile[], operation: WorkspaceOperation, options: { signal?: AbortSignal } = {}): Promise<SandboxResult> {
  await ensureSandbox();
  return await runWorker(fileWorker, { files, operation }, options.signal) as SandboxResult;
}
