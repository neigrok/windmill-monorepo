import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../', import.meta.url));

function sourcesUnder(directory) {
  return readdirSync(join(web, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourcesUnder(path);
    return /\.jsx?$/.test(entry.name) ? [readFileSync(join(web, path), 'utf8')] : [];
  });
}

function namesIn(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))].sort();
}

const code = sourcesUnder('src/products/roadmap').join('\n');
const doc = readFileSync(join(web, 'OBSERVABILITY.md'), 'utf8');
const roadmap = doc.slice(doc.indexOf('## Roadmap'));
const eventsTable = roadmap.slice(roadmap.indexOf('### Events'), roadmap.indexOf('### When an event stays silent'));
const failuresTable = roadmap.slice(roadmap.indexOf('### Technical failures'));

test('every event the roadmap emits has its row in OBSERVABILITY.md, and every row still has an emitter', () => {
  const inCode = [...new Set([
    ...namesIn(code, /\btrack\(\s*'([a-z_]+)'/g),
    ...namesIn(code, /name: '(roadmap_[a-z_]+)'/g),
    ...namesIn(code, /eventName = editing \? '([a-z_]+)'/g),
    ...namesIn(code, /eventName = editing \? '[a-z_]+' : '([a-z_]+)'/g),
  ])].sort();
  const documented = namesIn(eventsTable, /^\| [^|]+ \| `([a-z_]+)` \|/gm);
  assert.deepEqual(inCode, documented);
});

test('every Sentry operation the roadmap reports has its row in OBSERVABILITY.md, and every row still reports', () => {
  const reported = namesIn(code, /'(roadmap-[a-z]+(?:-[a-z]+)*)'/g);
  const documented = namesIn(failuresTable, /^\| `(roadmap-[a-z-]+)` \|/gm);
  assert.deepEqual(reported, documented);
});
