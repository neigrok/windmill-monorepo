// The shell reaches the sync engine's state only through the engine's own calls (engine.md §7.10, §7.12): no shell file
// writes through the engine's transaction or edits the device's metadata itself.

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
