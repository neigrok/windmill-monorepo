# web — the browser surface

One Vite/React superapp. Brand-wide rules live in the root `CLAUDE.md` and the monorepo map
in `STRUCTURE.md`; this file is only what is true inside this tree.

## Three zones under `src/`

- **`shell/`** — the app frame: `App.jsx` (hash router + product switcher), auth, billing,
  account, settings, connect, feedback, the marketing/landing chrome, PWA, and `apiBase.js`.
  The shell hard-codes no product.
- **`products/<p>/`** — one front-end per product (roadmap, journal, gym). Each exports a
  route table; `shell/products.js` is the registry that composes them, and it is the *only*
  place the shell learns a product exists.
- **`design-system/`** and the app-global `styles/` · `telemetry/` — product-neutral, and
  meant to stay provably so.

Products may use the shell's platform services (auth, billing, `apiBase`, the landing
chrome they mount into) but never the `/app` chrome, and never each other.

`test/shell-boundaries.test.mjs` enforces exactly that: it walks every import in `src/`
and fails naming the offending file and line, then reads the registry itself to check
every product declares the landing, the door copy and the hrefs the seam promises. It is
the first test to read when a boundary question comes up — the rule is written there, not
just in prose.

## Run it

```sh
npm run dev      # vite on :5173; apiBase falls back to http://localhost:8088 outside a prod build
npm test         # node --test over test/ — every case, no watch mode, no filter by default
npm run build    # runs the same tests, then vite build, then the per-landing HTML shells
```

`test/` mirrors `src/` (`test/products/<p>/…`, `test/shell/…`). `npm run build` is the
gate, not `vite build`: it runs the suite first, `prebuild` fetches the self-hosted
embedding weights into `public/models`, and the postbuild step writes one static shell per
landing so a crawler without JavaScript gets that landing's own head and body rather than
the brand root's.

`vite.config.js` carries a build-time tripwire: the roadmap's `DEFAULT_KINDS` /
`GENESIS_STAMP` must stay byte-equal to `packages/api-contract/genesis.js`, or a
locally-born tree silently diverges from the server's empty tree on claim. It throws at
config time — that is deliberate, not a stale check.

## Same origin in production

There is no API host baked into the bundle. Production serves the SPA and the backend from
one origin (Caddy path-routes `/v1`, `/mcp`, `/oauth`), so `shell/apiBase.js` resolves an
empty base and every request is relative; the collab socket derives `ws(s)://` from the
page. `VITE_API_BASE_URL` exists only for a preview build pointed at a remote backend.

The web deploy (`.github/workflows/web.yml`) builds and rsyncs `dist/` to the VPS on a push
to `main`. On a fresh host it must land **before** the backend deploy: the embedder sidecar
bind-mounts its model weights out of the served web directory
(`services/embedder/README.md`).
