import { readdirSync } from 'node:fs';
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
const runner = run({ files: files.sort(), concurrency: true, timeout: 120000 });
runner.on('test:fail', () => { process.exitCode = 1; });
runner.compose(spec()).pipe(process.stdout);
