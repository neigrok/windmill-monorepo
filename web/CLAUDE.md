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
the head each static page must carry.

`scripts/appBoot.js` runs in dev as well as build: it puts one `<style>` and one inline script into
`<head>` that paint an app room's own ground before the bundle arrives. It reads the room table off
`src/shell/products.js` and the ground colours out of `src/styles/tokens/palettes.css`, and throws at
build time if a palette changes shape or a product names a room module that is not there.
`test/boot.test.mjs` drives the emitted script against a fake document.

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
