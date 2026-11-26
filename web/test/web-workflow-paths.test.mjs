import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(web, '..');

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(path);
    return /\.(js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

function triggers(workflow, event) {
  const block = workflow.split(`\n  ${event}:\n`)[1].split(/\n {0,2}(?=\S)/)[0];
  return [...block.matchAll(/^\s+- '([^']+)'$/gm)].map((match) => match[1]).filter((pattern) => !pattern.startsWith('!'));
}

const covers = (pattern, path) => (pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : pattern === path);

test('Web CI runs on a change to every file outside web/ and packages/ that a web test reads', () => {
  const read = new Set();
  for (const file of testFiles(join(web, 'test'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/new URL\('((?:\.\.\/)+[^']*[^'/])', import\.meta\.url\)/g)) {
      const path = relative(root, resolve(dirname(file), match[1]));
      if (!path.startsWith('web/') && !path.startsWith('packages/') && !path.startsWith('..')) read.add(path);
    }
  }
  const workflow = readFileSync(join(root, '.github/workflows/web.yml'), 'utf8');
  const uncovered = Object.fromEntries(['push', 'pull_request'].map((event) => {
    const patterns = triggers(workflow, event);
    return [event, [...read].filter((path) => !patterns.some((pattern) => covers(pattern, path))).sort()];
  }));
  assert.ok(read.size > 0);
  assert.deepEqual(uncovered, { push: [], pull_request: [] });
});
