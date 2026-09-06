# web — the browser surface

One Vite/React superapp. Brand-wide rules are in the root `CLAUDE.md`, the monorepo map in
`STRUCTURE.md`. This file is only what is true inside this tree.

## Three zones under `src/`

- `shell/` — the app frame: `App.jsx` (hash router + product switcher), auth, billing, account,
  settings, connect, feedback, the marketing/landing chrome, PWA, `apiBase.js`. Hard-codes no
  product.
- `products/<p>/` — one front-end per product (roadmap, journal, gym). Each exports a route table;
  `shell/products.js` is the registry that composes them, and the only place the shell learns a
  product exists.
- `design-system/` plus the app-global `styles/` · `telemetry/` — product-neutral.

Products may use the shell's platform services (auth, billing, `apiBase`, the landing chrome they
mount into) but never the `/app` chrome, and never each other.
`test/shell-boundaries.test.mjs` enforces that: it walks every import in `src/` and fails naming the
offending file and line, then reads the registry to check every product declares the landing, the
door copy and the hrefs the seam promises. Read it first on a boundary question.

## Run it

```sh
npm run dev      # vite on :5173; apiBase falls back to http://localhost:8088 outside a prod build
npm test         # node --test over test/ — every case, no watch mode, no filter
npm run build    # the tests, then vite build, then the per-landing HTML shells
```

`test/` mirrors `src/` (`test/products/<p>/…`, `test/shell/…`).

`npm run build` is the gate, not `vite build`. It runs the suite first; `prebuild` fetches the
self-hosted embedding weights into `public/models`; `scripts/build-landing-shells.mjs` writes one
static shell per landing so a crawler without JavaScript gets that landing's own head and body, then
emits `sitemap.xml` from those shells and every page in `public/` — each under the URL its own
`<link rel="canonical">` names, skipped if its own robots meta says `noindex`. There is no
`sitemap.xml` in `public/` to edit; the pages are the source. `scripts/staticPageAssets.js` asserts
the head each static page must carry and serves the four files they all link: `/fonts.css`,
`/chrome.css` (`scripts/staticPageChrome.css` — the family tokens in both themes, so a static page
never names a colour of its own), `/boot.js`, the theme stamp, and `/appearance.js`
(`scripts/staticAppearance.js`) — the same Light · Dark toggle the landings carry, mounted first in
the nav's `.navr`, stamping `<html>` and repainting the metas itself since no bundle ever arrives.

`scripts/appBoot.js` runs in dev as well as build: it puts one `<style>` and one inline script into
`<head>` that stamp `<html>` before the bundle arrives. An app room is stamped with its brand and
theme and painted on its own ground in either theme; the brand root and each open product's landing
are stamped and painted only when the resolved appearance is dark — by day they carry the boot flag
alone, so their light pixels are untouched — and every other path is left alone. The `<style>` hides
the no-JS fallback body in an app room only; a landing shell and a static page keep theirs. The
script reads the room and landing tables off `src/shell/products.js` and the ground colours out of
`src/styles/tokens/colors.css` and `palettes.css`, and throws at build time if a palette changes
shape or a product names a room module that is not there. `test/boot.test.mjs` drives the emitted
scripts against a fake document.

Light or dark is one device preference, `src/shell/appearance.js` — a module-level store under the
`windmill:appearance` key that `useAppearance` reads through `useSyncExternalStore`, so a switch
reaches the shell, the landings and the other tabs at once. Two controls offer it: in the `/app`
head the account seat's pop-up (`shell/auth/AccountSeat.jsx`) carries Light · Dark · System; on
every landing, signed in or out, the nav's `shell/marketing/AppearanceToggle.jsx` carries Light ·
Dark right before the seat, whose pop-up draws no Appearance row there (`appearance={false}`) — the
checked segment is the resolved appearance, so with nothing stored it follows the device, and a
pick is an explicit choice with no way back to System short of the app's seat. Settings does not
offer it; a static page in `public/` carries the same nav toggle through `/appearance.js`. The same
module carries `paintBrowserChrome` and `restoreBrowserChrome`: the shell on every room or theme
change, and a landing at night, tell the browser's `theme-color` and `color-scheme` metas the
ground `<html>` wears, parking what they replace in `data-was` and handing it back on unmount.

`vite.config.js` throws at config time unless the roadmap's `DEFAULT_KINDS` / `GENESIS_STAMP` are
byte-equal to `packages/api-contract/genesis.js` — otherwise a locally-born tree diverges from the
server's empty tree on claim.

## Same origin in production

No API host is baked into the bundle. Production serves the SPA and the backend from one origin
(Caddy path-routes `/v1`, `/mcp`, `/oauth`), so `shell/apiBase.js` resolves an empty base and every
request is relative; the collab socket derives `ws(s)://` from the page. `VITE_API_BASE_URL` is for a
preview build pointed at a remote backend.

`.github/workflows/web.yml` builds and rsyncs `dist/` to the VPS on a push to `main`. On a fresh host
it must land **before** the backend deploy: the embedder sidecar bind-mounts its model weights out of
the served web directory (`services/embedder/README.md`).
