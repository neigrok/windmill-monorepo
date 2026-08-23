import fs from 'node:fs';

// Paints an app room's ground before the bundle arrives; a no-op outside /app.
const GROUND = '--neutral-50';
const THEMES = ['light', 'dark'];
// 'clay' is the neutral rooms' brand.
const brandsOf = (products) => ['clay', ...new Set(products.map((product) => product.shell.scope.brand))];

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

function assetsFor(bundle, modules, alreadyNamed = []) {
  if (!bundle) return [];

  // Match by the module a chunk contains: a merged chunk records no facade.
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
  return assets.filter((asset) => !alreadyNamed.includes(asset));
}

// `theme` null means the room follows the device.
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

// Each rewritten meta keeps what it replaced in `data-was`; the shell hands them back on leaving the room.
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
        const alreadyNamed = [...html.matchAll(/"\/assets\/[^"]+"/g)].map((hit) => hit[0].slice(1, -1));
        const rooms = readRooms(PRODUCTS).map((room) => ({ ...room, assets: assetsFor(ctx.bundle, room.modules, alreadyNamed) }));
        const neutral = assetsFor(ctx.bundle, ['src/shell/chrome/Shell.jsx'], alreadyNamed);

        return {
          html,
          tags: [
            // End of <head>: the script rewrites metas that do not exist at head-prepend.
            { tag: 'style', children: BOOT_STYLE, injectTo: 'head' },
            { tag: 'script', children: bootScript(rooms, grounds, neutral, KEY), injectTo: 'head' },
          ],
        };
      },
    },
  };
}
