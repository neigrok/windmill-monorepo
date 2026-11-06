import { SYNC_STATUS, SYNC_OFFLINE_SHORT, ANONYMOUS_OWNER } from '../../../src/products/roadmap/copy.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../../products/roadmap/browserFixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const offline = { line: SYNC_STATUS.offline, short: SYNC_OFFLINE_SHORT, icon: 'offline', narrow: 'icon' };
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { registerRoomStatus } from '/src/shell/roomStatus.js';
import { PRODUCTS } from '/src/shell/products.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
window.publish = (status) => {
  window.statusLease ??= registerRoomStatus();
  window.statusLease.publish(status);
  return () => { window.statusLease.release(); window.statusLease = null; };
};
const outside = () => React.createElement('button', { id: 'outside' }, 'Outside');
const query = new URLSearchParams(location.search);
const room = query.get('room') ?? (query.has('shared') ? 'roadmap' : null);
const props = { location: { pathname: room ? '/app/' + room : '/app', hash: '', search: '' } };
if (room === 'roadmap') {
  props.location = { pathname: '/', hash: '#/demo', search: '' };
  props.roomProduct = PRODUCTS.find((product) => product.id === 'roadmap');
} else if (room === 'home') {
  props.location.pathname = '/app';
} else if (!room) {
  props.neutral = { Component: outside };
}
createRoot(document.getElementById('root')).render(React.createElement(Shell, props));
`;
let server, origin;
const browsers = new Map();
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-shell-status-test`,
    plugins: [{ name: 'shell-status-test', enforce: 'pre',
      resolveId(id, importer) {
        if (id === '/shell-status-entry.js') return '\0shell-status-entry';
        if (id === './ShellHome.jsx' && importer?.endsWith('/shell/chrome/Shell.jsx')) return '\0shell-status-room';
        if (importer?.endsWith('/routes.js') && ['./index.js', './JournalApp.jsx', './GymApp.jsx', './CanvasGhost.jsx', './RoutinesGhost.jsx'].includes(id)) return '\0shell-status-room';
        if (id.endsWith('/auth/AuthProvider.jsx')) return '\0shell-status-auth';
        if (id.endsWith('/auth/SignInDoor.jsx')) return '\0shell-status-door';
        if (id.endsWith('/telemetry/beacon.js')) return '\0shell-status-events';
      },
      load(id) {
        if (id === '\0shell-status-entry') return entry;
        if (id === '\0shell-status-room') return `import React from 'react'; const Room = () => React.createElement('button', { id: 'outside' }, 'Outside'); export { Room as SkillTreeApp, Room as JournalApp, Room as GymApp, Room as ShellHome, Room as CanvasGhost, Room as RoutinesGhost };`;
        if (id === '\0shell-status-auth') return `export const useAuth = () => ({ status: location.search.includes('ghost') ? 'ghost' : 'signed-in', user: location.search.includes('ghost') ? null : { name: 'Ada' }, signOut() {} });`;
        if (id === '\0shell-status-door') return `export const useSignInDoor = () => () => { window.signInOpened = true; }; export const useSignInDoorHost = () => () => {};`;
        if (id === '\0shell-status-events') return beacon;
      },
      configureServer(vite) {
        vite.middlewares.use('/shell-status-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/shell-status-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } },
  });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
})();
ready.catch(() => {});
after(async () => {
  for (const browser of browsers.values()) await browser.then((instance) => instance.close(), () => {});
  await server?.close();
});

async function visit(t, width, run, query = '', engine = chromium) {
  await ready;
  if (!browsers.has(engine)) browsers.set(engine, engine.launch({ headless: true }));
  const browser = await browsers.get(engine);
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: query.includes('dark') ? 'dark' : 'light' });
  t.after(() => page.close());
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/shell-status-test${query}`);
    await page.locator('.wm-head-seat button').waitFor();
    await page.evaluate(async () => {
      const family = getComputedStyle(document.querySelector('.wm-switch-btn')).fontFamily;
      await Promise.all([400, 600, 700].map((weight) => document.fonts.load(`${weight} 12px ${family}`, 'Home Roadmap Journal Gym')));
      await document.fonts.ready;
    });
    await run(page);
  });
}

test('unpublished status leaves the entire header unchanged after a room clears', async (t) => {
  await visit(t, 1440, async (page) => {
    const before = await page.locator('.wm-head').evaluate((element) => element.outerHTML);
    assert.equal(await page.locator('.wm-room-status').count(), 0);
    await page.evaluate((status) => { window.releaseStatus = window.publish(status); }, offline);
    await page.locator('.wm-room-status').waitFor();
    await page.evaluate(() => window.releaseStatus());
    await page.locator('.wm-room-status').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.wm-head').evaluate((element) => element.outerHTML), before);
  });
});

for (const width of [1440, 744, 390, 320]) {
  test(`the Shell status has the drawn form, full announcement and visible seat at ${width}`, async (t) => {
    await visit(t, width, async (page) => {
      await page.evaluate((status) => window.publish(status), offline);
      await page.locator('.wm-room-status').waitFor();
      assert.equal(await page.getByRole('status').getAttribute('aria-label'), null);
      assert.equal(await page.getByRole('status').textContent(), offline.line);
      assert.equal(await page.locator('.wm-room-status-full').isVisible(), width >= 744);
      assert.equal(await page.locator('.wm-room-status-compact').isVisible(), width >= 360 && width < 744);
      assert.equal(await page.locator('.wm-room-status-tap').isVisible(), width < 360);
      const seat = await page.locator('.wm-head-seat').boundingBox();
      assert.equal(seat.x >= 0 && seat.x + seat.width <= width, true);
      const nav = await page.locator('.wm-switch').boundingBox();
      const slot = await page.locator('.wm-room-status').boundingBox();
      assert.equal(nav.x + nav.width <= slot.x, true);
      for (const line of [SYNC_STATUS.saving, SYNC_STATUS.saved]) {
        await page.evaluate((line) => window.publish({ line, narrow: 'announce' }), line);
        await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, line);
        assert.equal(await page.locator('.wm-room-status-compact').isVisible(), width >= 360 && width < 744);
        assert.equal(await page.locator('.wm-room-status-full').isVisible(), width >= 744);
        assert.equal(await page.locator('.wm-room-status-announcement').evaluate((element) => getComputedStyle(element).clipPath), 'inset(50%)');
      }
    });
  });
}

for (const width of [390, 320]) {
  test(`a Shared Shell room with no status draws no mark, the links from the edge and Sign in at the far end at ${width}`, async (t) => {
    await visit(t, width, async (page) => {
      assert.deepEqual(await page.evaluate(() => {
        const nav = document.querySelector('.wm-switch').getBoundingClientRect();
        const home = document.querySelector('.wm-switch-btn').getBoundingClientRect();
        const signIn = document.querySelector('.wm-head-sign-in').getBoundingClientRect();
        return {
          mark: getComputedStyle(document.querySelector('.wm-head-mark')).display,
          navLeft: nav.left,
          linkPadding: getComputedStyle(document.querySelector('.wm-switch-btn')).paddingInlineStart,
          homeHeight: home.height,
          activeFill: getComputedStyle(document.querySelector('.wm-switch-btn[aria-current="page"]')).backgroundColor,
          signInRight: signIn.right,
          clear: nav.right <= signIn.left,
          overflow: document.documentElement.scrollWidth > innerWidth,
          slots: document.querySelectorAll('.wm-room-status').length,
          liveRegions: document.querySelectorAll('[role="status"]').length,
        };
      }), { mark: 'none', navLeft: 16, linkPadding: '6px', homeHeight: 30, activeFill: 'rgba(0, 0, 0, 0)', signInRight: width - 16, clear: true, overflow: false, slots: 0, liveRegions: 0 });
    }, '?ghost&shared');
  });
}

for (const width of [390, 320]) {
  test(`a Shared Shell room's status keeps its links clear and its seat inside the page at ${width}`, async (t) => {
    await visit(t, width, async (page) => {
      await page.evaluate((status) => window.publish(status), offline);
      await page.locator('.wm-room-status').waitFor();
      assert.deepEqual(await page.evaluate(() => {
        const nav = document.querySelector('.wm-switch').getBoundingClientRect();
        const slot = document.querySelector('.wm-room-status').getBoundingClientRect();
        const seat = document.querySelector('.wm-head-seat').getBoundingClientRect();
        return { navLeft: nav.left, clear: nav.right <= slot.left, seatRight: seat.right, overflow: document.documentElement.scrollWidth > innerWidth };
      }), { navLeft: 16, clear: true, seatRight: width - 16, overflow: false });
    }, '?shared');
  });
}

test('from 744 a Shared Shell room hides the mark like every room', async (t) => {
  await visit(t, 744, async (page) => {
    assert.equal(await page.locator('.wm-head-mark').evaluate((element) => getComputedStyle(element).display), 'none');
  }, '?ghost&shared');
});

test('the icon tooltip closes after four seconds, a second tap, and an outside tap', async (t) => {
  await visit(t, 320, async (page) => {
    const start = new Date('2026-11-03T12:00:00Z');
    await page.clock.install({ time: new Date(start.getTime() - 60000) });
    await page.clock.pauseAt(start);
    await page.evaluate((status) => window.publish(status), offline);
    const tap = page.getByRole('button', { name: offline.line, exact: true });
    await tap.click();
    await page.getByRole('tooltip').waitFor();
    assert.equal(await tap.getAttribute('aria-describedby'), null);
    assert.equal(await page.getByRole('tooltip').textContent(), offline.line);
    const box = await page.getByRole('tooltip').boundingBox();
    assert.equal(box.x >= 0 && box.x + box.width <= 320, true);
    await page.clock.runFor(3999);
    assert.equal(await page.getByRole('tooltip').count(), 1);
    await page.clock.runFor(1);
    await page.getByRole('tooltip').waitFor({ state: 'detached' });
    await tap.click();
    await page.getByRole('tooltip').waitFor();
    await tap.click();
    await page.getByRole('tooltip').waitFor({ state: 'detached' });
    await tap.click();
    await page.getByRole('tooltip').waitFor();
    await page.locator('#outside').click();
    await page.getByRole('tooltip').waitFor({ state: 'detached' });
  });
});

test('the live region stays mounted across status changes and equal publication makes no mutation', async (t) => {
  await visit(t, 744, async (page) => {
    await page.evaluate((line) => window.publish({ line, narrow: 'announce' }), SYNC_STATUS.saving);
    await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, SYNC_STATUS.saving);
    await page.evaluate((line) => {
      window.liveRegion = document.querySelector('[role="status"]');
      window.mutations = [];
      new MutationObserver((records) => window.mutations.push(...records.map((record) => record.type)))
        .observe(window.liveRegion, { attributes: true, childList: true, characterData: true, subtree: true });
      window.publish({ line, narrow: 'announce' });
    }, SYNC_STATUS.saved);
    await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, SYNC_STATUS.saved);
    assert.equal(await page.evaluate(() => window.liveRegion === document.querySelector('[role="status"]')), true);
    assert.equal(await page.evaluate(() => window.mutations.length), 1);
    await page.evaluate((line) => { window.mutations = []; window.publish({ line, narrow: 'announce' }); }, SYNC_STATUS.saved);
    assert.deepEqual(await page.evaluate(() => window.mutations), []);
  });
});

test('the longest device line and account seat fit together at 744', async (t) => {
  await visit(t, 744, async (page) => {
    const line = ANONYMOUS_OWNER;
    await page.evaluate((line) => window.publish({ line }), line);
    await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, line);
    const nav = await page.locator('.wm-switch').boundingBox();
    const slot = await page.locator('.wm-room-status').boundingBox();
    const seat = await page.locator('.wm-head-seat').boundingBox();
    assert.equal(nav.x + nav.width <= slot.x, true);
    assert.equal(slot.x + slot.width <= seat.x, true);
    assert.equal(seat.x + seat.width <= 744, true);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    assert.equal(await page.evaluate(() => window.signInOpened), true);
  }, '?ghost');
});


for (const width of [390, 320]) {
  test(`registered idle, saving, saved and offline states keep the same phone chrome at ${width}`, async (t) => {
    await visit(t, width, async (page) => {
      await page.evaluate(() => window.publish(null));
      await page.getByRole('status').waitFor({ state: 'attached' });
      const geometry = () => page.evaluate(() => {
        const box = (selector) => {
          const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          mark: getComputedStyle(document.querySelector('.wm-head-mark')).display,
          nav: box('.wm-switch'), slot: box('.wm-room-status'), seat: box('.wm-head-seat'),
        };
      });
      const idle = await geometry();
      assert.equal(idle.mark, 'none');
      assert.equal(idle.slot.width, width < 360 ? 44 : 72);
      await page.evaluate(() => { window.originalRegion = document.querySelector('[role="status"]'); });
      for (const status of [{ line: SYNC_STATUS.saving, narrow: 'announce' }, { line: SYNC_STATUS.saved, narrow: 'announce' }, null, offline, null]) {
        await page.evaluate((status) => window.publish(status), status);
        await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, status?.line ?? '');
        assert.deepEqual(await geometry(), idle);
        assert.equal(await page.evaluate(() => window.originalRegion === document.querySelector('[role="status"]')), true);
      }
    });
  });
}

for (const status of [offline, { line: ANONYMOUS_OWNER }]) {
  test(`first publication ${status.line} adds text to an already committed live region`, async (t) => {
    await visit(t, 744, async (page) => {
      await page.evaluate((status) => {
        window.announcementChanges = [];
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.target.nodeType !== Node.ELEMENT_NODE || record.target.getAttribute('role') !== 'status') continue;
            window.announcementChanges.push({
              type: record.type,
              added: [...record.addedNodes].map((node) => ({ type: node.nodeType, text: node.textContent })),
            });
          }
        });
        observer.observe(document.querySelector('.wm-head'), { childList: true, subtree: true });
        window.publish(status);
      }, status);
      await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, status.line);
      assert.deepEqual(await page.evaluate(() => window.announcementChanges), [
        { type: 'childList', added: [{ type: 3, text: status.line }] },
      ]);
    });
  });
}


for (const width of [744, 1440]) {
  for (const query of ['', '?ghost']) {
    test(`registered desktop room links stay fixed through every status at ${width} ${query}`, async (t) => {
      await visit(t, width, async (page) => {
        await page.evaluate(() => window.publish(null));
        await page.locator('.wm-room-status').waitFor({ state: 'attached' });
        const navigation = await page.locator('.wm-switch').boundingBox();
        for (const status of [{ line: SYNC_STATUS.saving }, { line: SYNC_STATUS.saved }, offline, { line: ANONYMOUS_OWNER }, null]) {
          await page.evaluate((status) => window.publish(status), status);
          await page.waitForFunction((line) => document.querySelector('.wm-room-status-full')?.textContent === line, status?.line ?? '');
          assert.deepEqual(await page.locator('.wm-switch').boundingBox(), navigation);
          assert.deepEqual(await page.evaluate(() => {
            const nav = document.querySelector('.wm-switch').getBoundingClientRect();
            const slot = document.querySelector('.wm-room-status').getBoundingClientRect();
            const seat = document.querySelector('.wm-head-seat').getBoundingClientRect();
            const line = document.querySelector('.wm-room-status-full').getBoundingClientRect();
            return { navClear: nav.right <= slot.left, seatClear: slot.right <= seat.left,
              lineFits: line.width <= slot.width, seatFits: seat.right <= innerWidth };
          }), { navClear: true, seatClear: true, lineFits: true, seatFits: true });
        }
      }, query);
    });
  }
}

const linkBoxesByBand = new Map();

async function assertWideGeometry(page, { width, room, ghost, status, engine }) {
  const { actual, expected } = await page.evaluate(({ width, room, ghost, status }) => {
    const shell = document.querySelector('.wm-shell');
    const head = document.querySelector('.wm-head');
    const nav = document.querySelector('.wm-switch');
    const seat = document.querySelector('.wm-head-seat');
    const control = seat.querySelector('button');
    const slot = document.querySelector('.wm-room-status');
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.whiteSpace = 'nowrap';
    probe.style.visibility = 'hidden';
    shell.append(probe);
    const color = (token) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const primary = color('--text-primary');
    const secondary = color('--text-secondary');
    const expectedLinks = [];
    let left = 16;
    const links = [...nav.querySelectorAll('a')].map((link) => {
      const style = getComputedStyle(link);
      const box = link.getBoundingClientRect();
      probe.style.fontFamily = style.fontFamily;
      probe.style.fontSize = '12px';
      probe.style.fontWeight = '700';
      probe.style.lineHeight = '18px';
      probe.textContent = link.textContent;
      const width = Math.max(44, probe.getBoundingClientRect().width + 8);
      const current = link.textContent.toLowerCase() === room;
      expectedLinks.push({
        left, width, height: 44,
        fontSize: '12px', lineHeight: '18px', fontWeight: current ? '700' : '400',
        color: current ? primary : secondary, background: 'rgba(0, 0, 0, 0)',
        current: current ? 'page' : null, label: link.textContent,
      });
      left += width + 16;
      return {
        left: box.left, width: box.width, height: box.height,
        fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight,
        color: style.color, background: style.backgroundColor,
        current: link.getAttribute('aria-current'), label: link.dataset.label,
      };
    });
    const seatBox = control.getBoundingClientRect();
    let expectedStatus = null;
    let actualStatus = null;
    if (slot) {
      const style = getComputedStyle(slot);
      const box = slot.getBoundingClientRect();
      probe.style.fontFamily = style.fontFamily;
      probe.style.fontSize = '12px';
      probe.style.fontWeight = '600';
      probe.style.lineHeight = style.lineHeight;
      probe.textContent = status.line;
      expectedStatus = {
        width: probe.getBoundingClientRect().width,
        right: seatBox.left - 16,
        fontSize: '12px', fontWeight: '600', color: secondary,
      };
      actualStatus = {
        width: box.width, right: box.right,
        fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color,
      };
    }
    probe.remove();
    const signIn = ghost && (room === 'roadmap' || status !== null);
    const actual = {
      links,
      headHeight: head.getBoundingClientRect().height,
      mark: getComputedStyle(document.querySelector('.wm-head-mark')).display,
      status: actualStatus,
      seat: {
        right: seatBox.right, height: seatBox.height,
        avatarWidth: signIn ? null : seatBox.width,
        count: seat.querySelectorAll('button').length,
        tabIndex: control.tabIndex,
        visible: getComputedStyle(control).visibility,
        signIn: control.classList.contains('wm-head-sign-in'),
      },
      order: [...head.children].map((element) => element.classList[0]),
      clear: nav.getBoundingClientRect().right <= (slot?.getBoundingClientRect().left ?? seatBox.left),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
    const expected = {
      links: expectedLinks,
      headHeight: 52,
      mark: 'none',
      status: expectedStatus,
      seat: { right: width - 16, height: 44, avatarWidth: signIn ? null : 44, count: 1, tabIndex: 0, visible: 'visible', signIn },
      order: ['wm-head-mark', 'wm-switch', ...(status ? ['wm-room-status'] : []), 'wm-head-seat'],
      clear: true,
      overflow: false,
    };
    return { actual, expected };
  }, { width, room, ghost, status });
  assert.deepEqual(actual, expected);
  const boxes = actual.links.map(({ left, width, height }) => ({ left, width, height }));
  const band = `${engine.name()}:${width}`;
  if (!linkBoxesByBand.has(band)) linkBoxesByBand.set(band, boxes);
  assert.deepEqual(boxes, linkBoxesByBand.get(band));
}

for (const [engine, widths] of [[chromium, [744, 1024, 1440]], [webkit, [1024]]]) {
  for (const width of widths) {
    for (const room of ['home', 'roadmap', 'journal', 'gym']) {
      for (const ghost of [false, true]) {
        test(`${engine.name()} keeps every link fixed in ${room}, ${ghost ? 'ghost' : 'signed in'}, at ${width}`, async (t) => {
          await visit(t, width, async (page) => {
            await assertWideGeometry(page, { width, room, ghost, status: null, engine });
            for (const status of [{ line: SYNC_STATUS.saving }, { line: SYNC_STATUS.saved }, offline, { line: ANONYMOUS_OWNER }]) {
              await page.evaluate((status) => window.publish(status), status);
              await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, status.line);
              await page.evaluate(() => document.fonts.ready);
              await assertWideGeometry(page, { width, room, ghost, status, engine });
            }
          }, `?room=${room}${ghost ? '&ghost' : ''}`, engine);
        });
      }
    }
  }
}

for (const room of ['home', 'roadmap', 'journal', 'gym']) {
  test(`dark ${room} uses scoped tokens and the same wide geometry`, async (t) => {
    await visit(t, 1440, async (page) => {
      assert.equal(await page.locator('.wm-shell').getAttribute('data-theme'), 'dark');
      await assertWideGeometry(page, { width: 1440, room, ghost: true, status: null, engine: chromium });
      await page.evaluate((status) => window.publish(status), offline);
      await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, offline.line);
      await page.evaluate(() => document.fonts.ready);
      await assertWideGeometry(page, { width: 1440, room, ghost: true, status: offline, engine: chromium });
    }, `?room=${room}&ghost&dark`);
  });
}

for (const width of [390, 320]) {
  for (const room of ['home', 'journal', 'gym']) {
    test(`${room} retains its phone mark and avatar at ${width}`, async (t) => {
      await visit(t, width, async (page) => {
        assert.deepEqual(await page.evaluate(() => ({
          mark: getComputedStyle(document.querySelector('.wm-head-mark')).display,
          avatar: document.querySelectorAll('.wm-head-seat button[aria-expanded]').length,
          signIn: document.querySelectorAll('.wm-head-sign-in').length,
        })), { mark: 'flex', avatar: 1, signIn: 0 });
      }, `?room=${room}&ghost`);
    });
  }
}

for (const engine of [chromium, webkit]) {
  for (const width of [600, 743, 744]) {
    for (const ghost of [false, true]) {
      test(`${engine.name()} keeps the ${ghost ? 'ghost' : 'signed-in'} account popover eight pixels below its visual at ${width}`, async (t) => {
        await visit(t, width, async (page) => {
          await page.emulateMedia({ reducedMotion: 'reduce' });
          const control = page.locator('.wm-account-seat button[aria-expanded]');
          await control.dispatchEvent('click');
          await page.waitForFunction(() => document.querySelector('.wm-account-seat button[aria-expanded]')?.getAttribute('aria-expanded') === 'true');
          const geometry = await control.evaluate((button) => {
            const target = button.getBoundingClientRect();
            const visual = button.firstElementChild.getBoundingClientRect();
            const popover = document.getElementById(button.getAttribute('aria-controls')).getBoundingClientRect();
            return {
              target: [target.width, target.height],
              visual: [visual.width, visual.height],
              inset: [visual.left - target.left, visual.top - target.top],
              popoverGap: popover.top - visual.bottom,
              rightOffset: popover.right - target.right,
            };
          });
          const size = width >= 744 ? 44 : 30;
          const inset = (size - 30) / 2;
          assert.deepEqual(geometry, {
            target: [size, size], visual: [30, 30], inset: [inset, inset], popoverGap: 8, rightOffset: 0,
          });
        }, `?room=home${ghost ? '&ghost' : ''}`, engine);
      });
    }
  }
}
