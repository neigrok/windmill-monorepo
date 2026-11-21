import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { layoutFixtures } from '../../../../scripts/roadmap-layout-fixtures.mjs';

test('the shared layout fixtures are the picture the web draws today', () => {
  const directory = new URL('../../../../../packages/api-contract/roadmap/layout/', import.meta.url);
  const drawn = layoutFixtures();
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.json')).sort(), [...drawn.keys()].sort());
  const stale = [];
  for (const [name, text] of drawn) {
    const committed = readFileSync(new URL(name, directory), 'utf8').split('\n');
    const line = text.split('\n').findIndex((row, index) => row !== committed[index]);
    if (line !== -1 || committed.length !== text.split('\n').length) stale.push(`${name} from line ${line + 1}`);
  }
  assert.deepEqual(stale, [], 'the picture changed: run `npm run generate:roadmap-layout` and commit what it writes');
});

test('the fixtures hold every roadmap a port is held to, written in ASCII alone', () => {
  const directory = new URL('../../../../../packages/api-contract/roadmap/layout/', import.meta.url);
  const texts = readdirSync(directory).filter((name) => name.endsWith('.json') && name !== 'arithmetic.json').map((name) => readFileSync(new URL(name, directory), 'utf8'));
  assert.deepEqual(
    texts.map((text) => JSON.parse(text)).map((fixture) => [fixture.name, fixture.engine, fixture.roadmap.steps.length, fixture.links.length]).sort(([a], [b]) => (a < b ? -1 : 1)),
    [
      ['archipelago', 'bubble', 480, 360], ['braided', 'bubble', 48, 74], ['ceiling', 'bubble', 366, 364], ['deep', 'bubble', 183, 188], ['empty', 'bubble', 0, 0], ['fallback', 'radial', 34, 37],
      ['fallback-roots', 'radial', 25, 22], ['handbook', 'bubble', 5000, 5422], ['ids', 'bubble', 33, 36], ['islands', 'bubble', 35, 28],
      ['learn-to-sail', 'bubble', 8, 9], ['scripts', 'bubble', 21, 20], ['wide', 'bubble', 99, 98],
    ],
  );
  assert.deepEqual(texts.filter((text) => /[^ -~\n]/.test(text)).length, 0);
});
