#!/usr/bin/env node
// Runs the server and client dev servers together with prefixed output.
// Replaces `concurrently` (whose dependency shell-quote is blocked on Replit).
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const procs = [
  { name: 'server', color: '\x1b[34m', args: ['run', 'dev', '-w', 'server'] },
  { name: 'client', color: '\x1b[32m', args: ['run', 'dev', '-w', 'client'] },
];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tty = process.stdout.isTTY;
let failed = false;
let running = procs.length;
const children = [];

for (const p of procs) {
  const prefix = tty ? `${p.color}[${p.name}]\x1b[0m` : `[${p.name}]`;
  const child = spawn(npm, p.args, { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => console.log(`${prefix} ${line}`));
  }
  child.on('error', (err) => {
    failed = true;
    console.error(`${prefix} failed to start: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    if (code !== 0) failed = true;
    console.log(`${prefix} npm ${p.args.join(' ')} exited with code ${code ?? signal}`);
    if (--running === 0) process.exit(failed ? 1 : 0);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => children.forEach((c) => c.kill(sig)));
}
