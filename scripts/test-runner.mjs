import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2);
let runTarget;
const passthrough = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--run' && argv[i + 1]) {
    runTarget = argv[i + 1];
    i += 1;
    continue;
  }
  passthrough.push(argv[i]);
}

const defaultTarget = '.tmp-test/test/**/*.test.js';
let targets = [defaultTarget];
if (runTarget) {
  const normalized = runTarget.endsWith('.ts')
    ? `.tmp-test/${runTarget.replace(/\.ts$/, '.js')}`
    : runTarget;
  if (existsSync(normalized)) {
    targets = [normalized];
  }
}

const child = spawn('node', ['--test', ...targets, ...passthrough], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 1));
