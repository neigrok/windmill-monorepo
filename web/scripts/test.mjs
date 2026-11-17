import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

// `npm run build` holds production's DSN for its bundle. Tests that report inject their own, so a failure a test provokes never reaches production's Sentry project.
delete process.env.VITE_SENTRY_DSN;

const requestedConcurrency = process.env.WM_TEST_CONCURRENCY;
if (requestedConcurrency !== undefined && !['1', '2', '3', '4'].includes(requestedConcurrency)) {
  console.error('WM_TEST_CONCURRENCY must be exactly 1, 2, 3, or 4');
  process.exit(1);
}

const files = [];
function discover(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) discover(path);
    else if (/\.test\.(js|mjs)$/.test(entry.name)) files.push(path);
  }
}
const selected = process.argv[2] ?? 'test';
discover(selected);
if (resolve(selected).startsWith(resolve('test/platform/sync') + sep)) files.push('test/platform/sync/corpus.test.js');
const performanceFiles = files.filter((file) => /\.perf\.test\.(js|mjs)$/.test(file)).sort();
const runtimeFuzzFiles = files.filter((file) => file.endsWith('platform/sync/fuzz/runtime.test.js'));
const ordinaryFiles = files.filter((file) => !performanceFiles.includes(file) && !runtimeFuzzFiles.includes(file)).sort();
if (ordinaryFiles.length) {
  const concurrency = Math.min(Number(requestedConcurrency ?? 4), Math.max(1, availableParallelism() - 1));
  const runner = run({ files: ordinaryFiles, concurrency, timeout: 120000 });
  runner.on('test:fail', () => { process.exitCode = 1; });
  for await (const chunk of runner.compose(spec())) process.stdout.write(chunk);
}
if (runtimeFuzzFiles.length) {
  const runner = run({ files: runtimeFuzzFiles, concurrency: false, timeout: 300000 });
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
