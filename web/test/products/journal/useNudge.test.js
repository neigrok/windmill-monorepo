import test from 'node:test';
import assert from 'node:assert/strict';

import { renderHook, settle } from '../gym/harness.mjs';
import { useNudge } from '../../../src/products/journal/useNudge.js';

test('a signed-out seat asks for no nudge schedule, and a signed-in one reads its own', async (t) => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(new URL(url, 'https://windmill.works').pathname);
    return { ok: true, status: 200, json: async () => ({ enabled: true, armed: true, channel: 'email' }) };
  });
  let account = null;
  const run = renderHook(t, () => useNudge(account));
  await settle(8);
  const signedOut = { asked: [...asked], loading: run.log.loading, armed: run.log.armed };
  account = 'reader';
  run.redraw();
  await settle(8);
  assert.deepEqual({ signedOut, signedIn: { asked, loading: run.log.loading, armed: run.log.armed } }, {
    signedOut: { asked: [], loading: false, armed: false },
    signedIn: { asked: ['/v1/journal/nudge'], loading: false, armed: true },
  });
});
