import { spawn } from 'node:child_process';
const children = ['@nexrun/api', '@nexrun/web'].map(name => spawn('npm', ['run', 'dev', '--workspace', name], { stdio: 'inherit' }));
const stop = () => { for (const child of children) child.kill('SIGTERM'); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
for (const child of children) child.on('exit', code => { if (code && code !== 0) { stop(); process.exitCode = code; } });
