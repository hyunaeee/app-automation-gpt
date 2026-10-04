import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [
  spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.mjs'], { cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { cwd: root, stdio: 'inherit', windowsHide: true }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.connected) {
      child.send('shutdown');
      const timer = setTimeout(() => child.kill(), 5000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    } else child.kill();
  }
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
