// §2.5 of the wave-8 architecture: the device line and the demo's badge have their homes, and an open is never called a plant.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ANONYMOUS_OWNER, DEMO_BYLINE, LAPSED_SESSION } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('capabilitiesDoors');

const everyWidth = [320, 390, 744, 1440];

for (const [population, options] of [['an owner', {}], ['a reader', { role: 'reader' }], ['the demo', { role: 'reader', demo: true }]]) {
  hostTest(`Copy honesty: opening a roadmap never tells ${population} it was planted`, async () => {
    const { page, errors } = await openHost(options);
    try {
      await page.waitForFunction(() => window.arrivalToastSilenced === true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const [plant, flag] of [['a planted quest', 'windmill:planted-quest'], ['a fork of the demo', 'windmill:forked-from-demo']]) {
  hostTest(`Copy honesty: ${plant} keeps its arrival toast`, async () => {
    const { page, errors } = await openHost({});
    try {
      await page.evaluate((key) => sessionStorage.setItem(key, '1'), flag);
      await page.reload();
      await page.waitForFunction(() => window.scene?.nodesById?.size > 0);
      assert.equal(await page.evaluate(() => window.arrivalToastSilenced ?? false), false);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of everyWidth) {
  hostTest(`§2.5 Saved on this device / lapsed: the device line at ${width}px on Board and Graph`, async () => {
    for (const surface of ['board', 'tree']) {
      const { page, errors } = await openHost({ width, role: 'ghost', surface, shell: true });
      try {
        if (width < 744) {
          await page.getByRole('button', { name: ANONYMOUS_OWNER, exact: true }).click();
          assert.equal(await page.evaluate(() => window.signInOpened), 1);
        } else {
          await page.getByRole('status').filter({ hasText: ANONYMOUS_OWNER }).waitFor();
        }
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  hostTest(`§2.5 Saved on this device / lapsed: a lapsed session keeps its line at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, shell: true });
    try {
      await page.evaluate(async () => {
        window.session.receiveReject({ code: 'sign-in-required' });
        await Promise.resolve();
        window.setFixtureAuth('ghost');
      });
      const line = width < 744 ? page.getByRole('button', { name: LAPSED_SESSION, exact: true }) : page.getByRole('status').filter({ hasText: LAPSED_SESSION });
      await line.waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Demo plaque byline (G11): the sample badge at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true });
    try {
      const row = page.locator('.st-roadmap-identity[data-role="demo"]');
      await row.waitFor();
      assert.equal(await row.locator('.st-roadmap-sample').textContent(), width < 744 ? DEMO_BYLINE.phone : DEMO_BYLINE.wide);
      assert.equal(await page.getByText('Windmill demo').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
