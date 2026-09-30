import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

function collectTestFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(path);
    }
  }
  return files.sort();
}

let targets = collectTestFiles('.tmp-test/test');
if (runTarget) {
  const normalized = runTarget.endsWith('.ts')
    ? `.tmp-test/${runTarget.replace(/\.ts$/, '.js')}`
    : runTarget;
  if (existsSync(normalized)) {
    targets = [normalized];
  }
}

if (targets.length === 0) {
  process.stderr.write('No compiled test files found under .tmp-test/test.\n');
  process.exit(1);
}

const child = spawn('node', ['--test', ...targets, ...passthrough], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 1));
