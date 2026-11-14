import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { GUIDE, hostGuideSurfaces, open, settled, stepInert } from './guideSurfacesHost.js';

hostGuideSurfaces({ cache: 'guide-modal-window-test' });

for (const engine of [chromium, webkit]) {
  for (const [width, band] of [[744, 'tablet'], [1440, 'desktop']]) {
    for (const role of ['owner', 'reader']) {
      test(`${engine.name()}: ${role} reads the ${width}px Guide in a modal and returns to its entry`, async () => {
        const page = await open({ guide: GUIDE, band, role }, { engine, width, height: 960, reducedMotion: 'reduce' });
        try {
          await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
          const title = role === 'owner' ? 'Guide' : 'Author’s note';
          const card = page.getByRole('button', { name: `${title}: One step a week.` });
          await card.click();
          const note = page.getByRole('dialog', { name: title, exact: true });
          await note.waitFor();
          await settled(page);
          const box = await note.boundingBox();
          assert.deepEqual({ box: [box.x, box.y, box.width, box.height], modal: await note.getAttribute('aria-modal'), tree: await stepInert(page), text: await page.locator('.st-guide-prose').textContent() },
            { box: [24, 24, width - 48, 912], modal: 'true', tree: true, text: GUIDE });
          assert.equal(await note.getByRole('button', { name: 'Edit guide' }).count(), role === 'owner' ? 1 : 0);
          for (let press = 0; press < 4; press += 1) {
            await page.keyboard.press('Tab');
            assert.equal(await note.evaluate((element) => element.contains(document.activeElement)), true);
          }
          await page.keyboard.press('Escape');
          await note.waitFor({ state: 'detached' });
          await page.waitForFunction(() => document.activeElement.matches('.st-guide-card'));
          assert.equal(await stepInert(page), false);
        } finally { await page.close(); }
      });
    }
  }
}
