import fs from 'node:fs';

// The app boots into a room, and until 2026-08-23 it booted into the wrong one three times over: a
// visitor refreshing /app/journal at midnight got the brand root's cream marketing hero (Caddy hands
// every /app path index.html), then the router's light wordmark screen, then — finally — the dark
// canvas. Three full-viewport repaints, the first two of them bright, before the page they asked for.
//
// Nothing in that sequence was a bandwidth problem. It was that the HTML the server sends says
// nothing about which room is being opened, so the ground could not be right until React had run.
// This plugin makes the served HTML answer that question before a single byte of the bundle arrives:
// one <style> and one script in <head>, keyed on location.pathname, no-op anywhere outside /app.
//
// It is a Vite plugin rather than a postbuild step so dev and prod boot the same way — the flash
// this removes is exactly the kind that comes back the moment the fix only exists in dist/. The
// cost of living in index.html is that these bytes also ride the landing shells and every share
// page, where they do nothing: a room table and a ground map, inert but carried.
//
// THREE RULES HOLD THIS TOGETHER, and each one is a thing that would otherwise drift:
//
//   · The ground colours are READ OUT OF palettes.css at build time, never retyped here. A room's
//     ground is one fact and tokens/palettes.css is where it lives; a second copy in a script is a
//     copy that goes stale the first time a palette is tuned. readGrounds() below resolves the same
//     cascade the browser would, and throws if a palette stops being shaped the way it reads.
//   · The room table is READ OFF THE REGISTRY (src/shell/products.js). The shell may not name a
//     product, and neither may its boot. Plain Node can import that module — the route tables keep
//     their components behind lazy(() => import(...)), so nothing .jsx is touched resolving it.
//   · The pre-CSS ground is handed over as a custom-property FALLBACK, not as an inline background.
//     `background: var(--surface-canvas, var(--wm-boot-ground))` paints the hex only while
//     --surface-canvas is still undefined — i.e. only in the moment before the stylesheet lands.
//     After that the token wins and the ground follows the room live, so switching rooms in-app
//     can never leave a stale colour welded to <html>.

const GROUND = '--neutral-50';
const THEMES = ['light', 'dark'];
// Clay is the family default the neutral rooms wear; every other brand is whichever one a product
// declares. Derived rather than listed, so a fourth product's ground is read the day it opens.
const brandsOf = (products) => ['clay', ...new Set(products.map((product) => product.shell.scope.brand))];

// The declarations of one selector, as a plain map. Two things this has to get right, and both of
// them bit: comments are stripped FIRST, because these palettes carry a prose comment above almost
// every group and an unstripped one glues itself onto the name of the declaration below it; and
// comma groups count, because palettes.css states the light rooms' shared roles as one list and a
// parser that only saw the first selector would read a room as having no block at all.
function declarations(css, selector) {
  const found = {};
  const pattern = new RegExp(`(^|,)\\s*${selector.replace(/[[\]"$^*+?.()|{}\\]/g, '\\$&')}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'gm');
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(pattern)) {
    for (const line of block[3].split(';')) {
      const [name, value] = line.split(':');
      if (name && value) found[name.trim()] = value.trim();
    }
  }
  return found;
}

// What --surface-canvas resolves to for every (theme, brand) the app can boot into, resolved the way
// the cascade would: the family root, then colors.css's dark block, then the room's own pair block.
// Every palette states its ground as `--surface-canvas: var(--neutral-50)` and re-points the ramp
// underneath it, so the ground IS --neutral-50 — asserted here rather than assumed, because the day
// that stops being true this file would silently start emitting the wrong colour.
export function readGrounds(colorsCss, palettesCss, brands) {
  const root = declarations(colorsCss, ':root');
  const night = declarations(colorsCss, '[data-theme="dark"]');
  for (const [where, block] of [['root', root], ['the dark block', night]]) {
    if (block['--surface-canvas'] !== `var(${GROUND})`) {
      throw new Error(`appBoot: tokens/colors.css no longer says --surface-canvas: var(${GROUND}) at ${where}, so the boot ground can no longer be read off ${GROUND} — teach readGrounds the new shape rather than letting it emit a stale colour`);
    }
  }

  const grounds = {};
  for (const theme of THEMES) {
    for (const brand of brands) {
      const pair = declarations(palettesCss, `[data-theme="${theme}"][data-brand="${brand}"]`);
      const ground = pair[GROUND] ?? (theme === 'dark' ? night[GROUND] : root[GROUND]);
      if (!/^#[0-9A-Fa-f]{6}$/.test(ground)) {
        throw new Error(`appBoot: the ${theme} ${brand} ground read as "${ground}" rather than a hex — tokens/palettes.css changed shape and the boot would paint a colour nobody chose`);
      }
      grounds[`${theme}|${brand}`] = ground;
    }
  }
  return grounds;
}

// The assets a product room needs that the HTML would otherwise never mention. The two neutral
// rooms get Shell alone — settings and connect still discover their own page the slow way, which
// is a fair trade for not preloading an account surface behind every visit to the app. The router only learns which
// product to load after the entry chunk has downloaded, parsed and run, so /app/journal spent two
// extra serial round trips discovering Shell.jsx and then JournalApp.jsx. Naming them here puts all
// three in the same flight. JS is modulepreloaded; CSS is preloaded as a style rather than linked as
// one, so warming a room's sheet can never make it render-blocking.
function assetsFor(bundle, modules, alreadyNamed = []) {
  if (!bundle) return [];

  // By the module a chunk CONTAINS, not by the one it faces. A facade is only recorded when a chunk
  // corresponds to exactly one entry, and roadmap's room does not: its barrel is shared with the
  // share-video export, so Rollup merges it and the facade is null. Containment is the question
  // actually being asked here anyway — which file do I have to download to have this module.
  const owner = (module) => Object.values(bundle).find(
    (chunk) => chunk.modules && Object.keys(chunk.modules).some((id) => id.replace(/\\/g, '/').endsWith(module)),
  );

  const assets = [];
  const seen = new Set();
  const walk = (chunk) => {
    if (!chunk || seen.has(chunk.fileName)) return;
    seen.add(chunk.fileName);
    assets.push(`/${chunk.fileName}`);
    for (const css of chunk.viteMetadata?.importedCss ?? []) assets.push(`/${css}`);
    for (const name of chunk.imports ?? []) walk(bundle[name]);
  };

  for (const module of modules) {
    const chunk = owner(module);
    if (!chunk) throw new Error(`appBoot: no built chunk contains ${module} — the room would preload nothing, and a rename is the usual reason`);
    walk(chunk);
  }
  // Whatever the document already names — the entry and its static graph — is dropped: Vite has
  // preloaded those since before any of this, and a second tag for the same URL is a line of script
  // that buys the visitor nothing.
  return assets.filter((asset) => !alreadyNamed.includes(asset));
}

// The product rooms the boot can land in, in registry order. `theme` is the room's PIN — gym's
// instrument skin is basalt whatever the device prefers — and null means the room follows the
// device. The neutral account surfaces are not here: they are the clay default in bootScript.
function readRooms(products) {
  return products
    .filter((product) => product.shell.status === 'open')
    .map((product) => ({
      path: product.shell.room,
      brand: product.shell.scope.brand,
      theme: product.shell.scope.theme ?? null,
      modules: ['src/shell/chrome/Shell.jsx', product.shell.module],
    }));
}

// Deliberately small and deliberately dull. It runs before anything else on the page, on every
// document served from index.html — including the three landing shells and every /t/:id share page,
// which is why the first line is the only line that runs for them.
export function bootScript(rooms, grounds, neutral, storageKey) {
  const table = rooms.map((room) => [room.path, room.brand, room.theme, room.assets]);
  return `(function(){var d=document.documentElement,p=location.pathname;
if(p!=='/app'&&p.slice(0,5)!=='/app/')return;
var R=${JSON.stringify(table)},G=${JSON.stringify(grounds)},b='clay',t=null,a=${JSON.stringify(neutral)};
for(var i=0;i<R.length;i++){if(p===R[i][0]||p.slice(0,R[i][0].length+1)===R[i][0]+'/'){b=R[i][1];t=R[i][2];a=R[i][3];break}}
if(!t){var s=null;try{s=localStorage.getItem('${storageKey}')}catch(e){}
t=(s==='light'||s==='dark')?s:((window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light')}
d.setAttribute('data-wm-boot','app');d.setAttribute('data-theme',t);d.setAttribute('data-brand',b);
var g=G[t+'|'+b];if(g){d.style.setProperty('--wm-boot-ground',g);
var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute('data-was',m.content);m.setAttribute('content',g)}}
var c=document.querySelector('meta[name="color-scheme"]');if(c){c.setAttribute('data-was',c.content);c.setAttribute('content',t)}
for(var j=0;j<a.length;j++){var l=document.createElement('link'),u=a[j];
if(u.slice(-4)==='.css'){l.rel='preload';l.as='style'}else{l.rel='modulepreload'}
l.crossOrigin='';l.href=u;document.head.appendChild(l)}})();`;
}

// Each meta keeps what it was replacing in `data-was`. Leaving a room is not always a document
// load — the head mark is an ordinary link the router answers with a pushState — and a phone left
// wearing journal-night in its address bar over the cream brand root is the same lie as a flash,
// held instead of flashed. The shell hands them back on the way out (chrome/Shell.jsx).
//
// The ground, and the one thing that has to be hidden to get to it. index.html carries the brand
// root's marketing hero inside #root as the body a crawler and a no-JS visitor see — correct for
// every page except an app room, where it is a cream page nobody asked for standing in front of a
// dark one. It is hidden rather than removed: the same HTML is still the landings' and the share
// pages' real content, and this file may not take that away from them.
export const BOOT_STYLE = `html[data-wm-boot="app"]{background:var(--surface-canvas,var(--wm-boot-ground))}
html[data-wm-boot="app"] #root>main{display:none}`;

export function appBoot() {
  return {
    name: 'windmill:app-boot',
    transformIndexHtml: {
      order: 'post',
      async handler(html, ctx) {
        const { PRODUCTS } = await import(new URL('../src/shell/products.js', import.meta.url).href);
        const { KEY } = await import(new URL('../src/shell/appearance.js', import.meta.url).href);
        const grounds = readGrounds(
          fs.readFileSync(new URL('../src/styles/tokens/colors.css', import.meta.url), 'utf8'),
          fs.readFileSync(new URL('../src/styles/tokens/palettes.css', import.meta.url), 'utf8'),
          brandsOf(PRODUCTS),
        );
        // Whatever the document already names is not worth a second tag; the entry and its static
        // graph are preloaded by Vite before any of this.
        const alreadyNamed = [...html.matchAll(/"\/assets\/[^"]+"/g)].map((hit) => hit[0].slice(1, -1));
        const rooms = readRooms(PRODUCTS).map((room) => ({ ...room, assets: assetsFor(ctx.bundle, room.modules, alreadyNamed) }));
        const neutral = assetsFor(ctx.bundle, ['src/shell/chrome/Shell.jsx'], alreadyNamed);

        return {
          html,
          tags: [
            // Both at the END of <head>, not the start: the script rewrites the theme-color and
            // color-scheme metas, and at head-prepend those tags do not exist yet — it would find
            // nothing and quietly leave the browser painting the light chrome it was going to.
            // Everything here still runs before the first paint either way.
            { tag: 'style', children: BOOT_STYLE, injectTo: 'head' },
            { tag: 'script', children: bootScript(rooms, grounds, neutral, KEY), injectTo: 'head' },
          ],
        };
      },
    },
  };
}
