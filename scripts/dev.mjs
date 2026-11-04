import { spawn } from 'node:child_process';
const children = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { /* The owned process group may have already exited. */ }
  }
}
for (const name of ['@nexrun/api', '@nexrun/web']) {
  const child = spawn('npm', ['run', 'dev', '--workspace', name], { stdio: 'inherit', detached: process.platform !== 'win32' });
  children.push(child);
  child.on('error', () => { process.exitCode = 1; stop(); });
  child.on('exit', code => { if (!stopping) { process.exitCode = code ?? 1; stop(); } });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
