// packages/api-contract/roadmap-addresses.json: the backend builds every address it holds, and this proves the router
// opens each one — the roadmap it names, and the step — as the web itself writes them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { appTarget, pathTarget, roadmapRoutes } from '../../../src/products/roadmap/routes.js';
import { hashWithStep, routeOf, stepOf } from '../../../src/products/roadmap/step/stepAddress.js';

const VECTOR = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/roadmap-addresses.json', import.meta.url), 'utf8'));

// The address after the origin, split as the browser's location splits it.
function locationOf(address) {
  const url = new URL(address, 'https://app.example');
  return { pathname: url.pathname, hash: url.hash, search: url.search };
}

// The route a view stands on at this location: routeOf reads the browser's own location.
function routeAt(location) {
  globalThis.window = { location };
  try {
    return routeOf();
  } finally {
    delete globalThis.window;
  }
}

test('the shared vector holds every form for a roadmap you own and one you can only read', () => {
  assert.equal(VECTOR.cases.length, 24);
  assert.deepEqual(
    [...new Set(VECTOR.cases.map((one) => `${one.yours ? 'yours' : 'theirs'} ${one.nodeId === undefined ? 'roadmap' : 'step'}`))],
    ['yours roadmap', 'theirs roadmap', 'yours step', 'theirs step'],
  );
});

for (const one of VECTOR.cases) {
  test(`${one.why} — ${one.address}`, () => {
    const at = locationOf(one.address);
    const step = one.nodeId ?? null;
    const roadmap = one.yours ? `/#/app/${one.treeId}` : `/t/${one.treeId}`;

    if (one.yours) assert.equal(appTarget(at.hash).treeId, one.treeId);
    else assert.equal(pathTarget(at.pathname)?.treeId, one.treeId);
    const view = roadmapRoutes.render(at);
    assert.deepEqual([view.inRoom, view.props.treeId], [true, one.treeId]);

    assert.equal(stepOf(at.hash), step);
    assert.equal(routeAt(at), roadmap);

    // The web writes the step as SkillTreeView does: the roadmap's hash with the step set, or the share page with a
    // hash that holds only the step.
    const written = step === null ? roadmap
      : one.yours ? `/${hashWithStep(`#/app/${one.treeId}`, step)}` : `${roadmap}${hashWithStep('', step)}`;
    assert.equal(written, one.address);
  });
}
