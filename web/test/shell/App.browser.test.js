import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../products/roadmap/browserFixture.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
// The app over stand-ins for accounts, sessions and the rooms. `land` mounts it afresh on an address, so a room whose
// module an earlier landing resolved mounts in the app's first commit, before the commit's layout effects run.
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '/src/shell/App.jsx';
import { replaceLocation } from '/src/shell/navigation.js';
let mounted = null;
window.land = (href) => {
  mounted?.unmount();
  window.roomMounts = [];
  replaceLocation(href);
  mounted = createRoot(document.getElementById('root'));
  mounted.render(React.createElement(App));
};
`;
// The roadmap's room as its step address alone, noting the path the navigation had accepted as it mounted.
const rooms = `
import React, { useState } from 'react';
import { readNavigation } from '/src/shell/navigation.js';
import { useStepAddress } from '/src/products/roadmap/step/stepAddress.js';
export function SkillTreeApp() {
  useState(() => window.roomMounts.push(readNavigation().pathname));
  const address = useStepAddress();
  return React.createElement('div', null,
    React.createElement('button', { type: 'button', onClick: () => address.open('wind', 'card') }, 'Open Read the wind'),
    React.createElement('output', null, address.id ?? 'none'));
}
const Room = () => null;
export { Room as JournalApp, Room as GymApp, Room as CanvasGhost, Room as RoutinesGhost, Room as ShellHome };
`;
const stand = {
  auth: `import React from 'react';
    const account = { status: 'signed-in', user: { name: 'Ada' }, account: null, dataScope: null, roomChanging: false, signIn() {}, signOut() {} };
    export const useAuth = () => account;
    export default function AuthProvider({ children }) { return children; }`,
  entitlements: `export const useEntitlements = () => ({}); export default function EntitlementsProvider({ children }) { return children; }`,
  door: `export const useSignInDoor = () => () => {}; export const useSignInDoorHost = () => () => {};
    export function SignInDoorProvider({ children }) { return children; } export default SignInDoorProvider;`,
  sessions: `export function ProductSessions({ children }) { return children; } export function ProductSessionNotices() { return null; }`,
};
let server, origin, browser;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-app-door-test`,
    plugins: [{ name: 'app-door-test', enforce: 'pre',
      resolveId(id, importer) {
        if (id === '/app-door-entry.js') return '\0app-door-entry';
        if (id === './ShellHome.jsx' && importer?.endsWith('/shell/chrome/Shell.jsx')) return '\0app-door-rooms';
        if (importer?.endsWith('/routes.js') && ['./index.js', './JournalApp.jsx', './GymApp.jsx', './CanvasGhost.jsx', './RoutinesGhost.jsx'].includes(id)) return '\0app-door-rooms';
        if (id.endsWith('/auth/AuthProvider.jsx')) return '\0app-door-auth';
        if (id.endsWith('/billing/EntitlementsProvider.jsx')) return '\0app-door-entitlements';
        if (id.endsWith('/auth/SignInDoor.jsx')) return '\0app-door-door';
        if (id.endsWith('/ProductSessions.jsx')) return '\0app-door-sessions';
        if (id.endsWith('/telemetry/beacon.js')) return '\0app-door-events';
      },
      load(id) {
        if (id === '\0app-door-entry') return entry;
        if (id === '\0app-door-rooms') return rooms;
        if (id === '\0app-door-auth') return stand.auth;
        if (id === '\0app-door-entitlements') return stand.entitlements;
        if (id === '\0app-door-door') return stand.door;
        if (id === '\0app-door-sessions') return stand.sessions;
        if (id === '\0app-door-events') return beacon;
      },
      configureServer(vite) {
        vite.middlewares.use('/app-door-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/app-door-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../', import.meta.url))] } },
  });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
ready.catch(() => {});
after(async () => {
  await browser?.close();
  await server?.close();
});

test('a roadmap room mounted while its legacy door still stands in the URL opens a step once the door upgrades', async (t) => {
  await ready;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  t.after(() => page.close());
  page.setDefaultTimeout(10_000);
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/app-door-test`);
    await page.waitForFunction(() => typeof window.land === 'function');
    const open = page.getByRole('button', { name: 'Open Read the wind', exact: true });
    await page.evaluate(() => window.land('/app/roadmap#/app/t_0123456789abcdef'));
    await open.waitFor();
    await page.evaluate(() => window.land('/#/app/t_0123456789abcdef'));
    await page.waitForFunction(() => window.location.pathname === '/app/roadmap');
    await open.waitFor();
    assert.equal(await page.evaluate(() => window.roomMounts[0]), '/', 'the room mounted before the door upgraded');
    await open.click();
    await page.waitForFunction(() => window.location.hash === '#/app/t_0123456789abcdef?step=wind');
    const shown = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done({
      href: `${window.location.pathname}${window.location.hash}`, step: document.querySelector('output').textContent, mounts: window.roomMounts,
    })))));
    assert.deepEqual(shown, { href: '/app/roadmap#/app/t_0123456789abcdef?step=wind', step: 'wind', mounts: ['/', '/app/roadmap'] });
  });
});
