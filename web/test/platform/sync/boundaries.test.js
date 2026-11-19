// The shell and the products reach the sync engine's state only through the engine's own calls (engine.md §2.5, §7.10,
// §7.12): no shell file writes through the engine's transaction or edits the device's metadata itself, and no product
// reaches into a replica's device rows or the device's replicas, but for the files named below that still do.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(js|jsx|mjs)$/.test(entry.name) ? [full] : [];
  });
}

// Every line of the files under `directory` that matches one of `shapes`, as `file:line`.
function linesMatching(directory, shapes) {
  return sourceFiles(directory).flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
    shapes.some((shape) => shape.test(line)) ? [`${path.relative(SRC, file)}:${index + 1}`] : []));
}

test('no shell file writes the engine\'s state: it asks the engine', () => {
  assert.deepEqual(linesMatching(path.join(SRC, 'shell'), [
    /\bengine\.write\(/,
    /\bmeta\.[A-Za-z]+\s*=[^=]/,
    /\bdelete\s+[\w.?]*\bmeta\./,
  ]), []);
});

// Each of these still edits device rows inside the engine's own transaction (a product hook handed a replica, a commit
// body, the journal's carry-over), which no public read replaces; the list only shrinks.
test('products reach device rows and replicas only through the engine, but for the files still to move', () => {
  const files = [...new Set(linesMatching(path.join(SRC, 'products'), [/\.deviceRows\(/, /\bdevice\.replicas\b/])
    .map((line) => line.split(':')[0]))].sort();
  assert.deepEqual(files, [
    'products/gym/gymRuntime.js',
    'products/journal/claims.js',
    'products/journal/migrate.js',
    'products/journal/pages.js',
  ]);
});
