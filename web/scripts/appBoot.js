import fs from 'node:fs';

// Paints a page's ground before the bundle arrives: an app room's own, or the family's on the brand
// root and the product landings. Every other path is left alone — /t/:id share pages included.
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

// The brand root wears clay; an open product's landing wears that product, as its room does.
export function readLandings(products) {
  return [
    { path: '/', brand: 'clay' },
    ...products
      .filter((product) => product.shell.status === 'open')
      .map((product) => ({ path: product.shell.landingHref, brand: product.shell.scope.brand })),
  ];
}

// The ladder appearance.js states, in ES5: an explicit choice, else the device, else light.
const resolveTheme = (storageKey) => `if(!t){var s=null;try{s=localStorage.getItem('${storageKey}')}catch(e){}
t=(s==='light'||s==='dark')?s:((window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light')}`;

// Stamps <html> with what was decided (k = the kind of page, t = theme, b = brand) and tells the
// browser's own chrome the ground. A landing or a static page by day is stamped as booting and
// nothing more — the pixels of a landing by day are the pixels it had before any of this existed,
// and its root stamps nothing by day either. Each rewritten meta keeps what it replaced in `data-was`.
const STAMP = `d.setAttribute('data-wm-boot',k);if(k!=='app'&&t!=='dark')return;
d.setAttribute('data-theme',t);d.setAttribute('data-brand',b);
var g=G[t+'|'+b];if(g){d.style.setProperty('--wm-boot-ground',g);
var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute('data-was',m.content);m.setAttribute('content',g)}}
var c=document.querySelector('meta[name="color-scheme"]');if(c){c.setAttribute('data-was',c.content);c.setAttribute('content',t)}`;

export function bootScript(rooms, landings, grounds, neutral, storageKey) {
  const table = rooms.map((room) => [room.path, room.brand, room.theme, room.assets]);
  const openPages = landings.map((landing) => [landing.path, landing.brand]);
  return `(function(){var d=document.documentElement,p=location.pathname,k=null,b='clay',t=null,a=[];
var R=${JSON.stringify(table)},L=${JSON.stringify(openPages)},G=${JSON.stringify(grounds)};
if(p==='/app'||p.slice(0,5)==='/app/'){k='app';a=${JSON.stringify(neutral)};
for(var i=0;i<R.length;i++){if(p===R[i][0]||p.slice(0,R[i][0].length+1)===R[i][0]+'/'){b=R[i][1];t=R[i][2];a=R[i][3];break}}}
else{for(var j=0;j<L.length;j++){if(p===L[j][0]||p===L[j][0]+'/'){k='landing';b=L[j][1];break}}}
if(!k)return;
${resolveTheme(storageKey)}
for(var n=0;n<a.length;n++){var l=document.createElement('link'),u=a[n];
if(u.slice(-4)==='.css'){l.rel='preload';l.as='style'}else{l.rel='modulepreload'}
l.crossOrigin='';l.href=u;document.head.appendChild(l)}
${STAMP}})();`;
}

// The plain HTML pages in public/ link this as /boot.js (scripts/staticPageAssets.js): every one of
// them is a neutral page, so it is clay in whichever theme the visitor chose.
export function staticBootScript(grounds, storageKey) {
  return `(function(){var d=document.documentElement,k='static',b='clay',t=null,G=${JSON.stringify(grounds)};
${resolveTheme(storageKey)}
${STAMP}})();`;
}

// The ground is a custom-property FALLBACK: an inline background would outlive the room. The no-JS
// fallback body is hidden in an app room only, where the script that mounts over it is coming; a
// landing shell or a static page keeps its body on screen.
export const BOOT_STYLE = `html[data-wm-boot]{background:var(--surface-canvas,var(--wm-boot-ground))}
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
        const landings = readLandings(PRODUCTS);

        return {
          html,
          tags: [
            // End of <head>: the script rewrites metas that do not exist at head-prepend.
            { tag: 'style', children: BOOT_STYLE, injectTo: 'head' },
            { tag: 'script', children: bootScript(rooms, landings, grounds, neutral, KEY), injectTo: 'head' },
          ],
        };
      },
    },
  };
}
