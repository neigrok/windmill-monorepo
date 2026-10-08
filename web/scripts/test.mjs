import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const files = [];
function discover(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) discover(path);
    else if (/\.test\.(js|mjs)$/.test(entry.name)) files.push(path);
  }
}
discover(process.argv[2] ?? 'test');
const performanceFiles = files.filter((file) => /\.perf\.test\.(js|mjs)$/.test(file)).sort();
const ordinaryFiles = files.filter((file) => !performanceFiles.includes(file)).sort();
if (ordinaryFiles.length) {
  const runner = run({ files: ordinaryFiles, concurrency: true, timeout: 120000 });
  runner.on('test:fail', () => { process.exitCode = 1; });
  for await (const chunk of runner.compose(spec())) process.stdout.write(chunk);
}
// Run the large training fixtures after the parallel workers have exited.
if (performanceFiles.length) {
  const result = spawnSync(process.execPath,
    ['--test', '--test-concurrency=1', '--test-timeout=120000', ...performanceFiles], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = 1;
}
