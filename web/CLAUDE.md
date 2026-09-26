# Web

One Vite/React superapp for roadmap, journal and gym. Brand rules are in the root `CLAUDE.md`;
[STRUCTURE.md](../STRUCTURE.md) defines dependency direction.

## Boundaries

- `shell/` owns routing, account, billing, settings, marketing chrome and platform services.
  `shell/products.js` composes product registrations.
- `products/<product>/` owns each product's routes, UI and domain logic. Products may use shell
  platform services but cannot import another product or the `/app` chrome.
- `design-system/`, `styles/` and `telemetry/` are product-neutral.

`test/shell-boundaries.test.mjs` checks imports, product landing registrations and public entry
points. Tests mirror `src/` under `test/`.

## Run and build

```sh
npm run dev      # localhost:5173; development API defaults to localhost:8088
npm test         # complete Node test suite
npm run build    # fetch model weights, run tests, build Vite and static landing shells
```

Use `npm run build` as the gate. `prebuild` fetches self-hosted weights into `public/models`;
`vite build` alone skips that step, tests and static-page generation.

`vite.config.js` checks that roadmap's `DEFAULT_KINDS` and `GENESIS_STAMP` match
`packages/api-contract/genesis.js`, preserving agreement between device and server trees.

## Static pages and search

`scripts/build-landing-shells.mjs` builds `/`, `/roadmap`, `/journal` and `/gym` from
`shell/marketing/landingHeads.js` and each product's `marketing/landingHead.js`. These modules
must be plain Node-readable data: no top-level JSX imports or browser globals. Each landing has
its own head and no-JS body. Shelf pages live in `public/`.

The build generates `sitemap.xml` from canonical URLs, excluding `noindex` pages; there is no
source sitemap to edit. `staticPageAssets.js` checks canonical, Open Graph and Twitter metadata
and supplies shared fonts, chrome, boot and appearance assets. Missing landing modules or fallback
bodies fail the build.

Caddy serves real 404s, redirects extensionless static paths to their canonicals and forwards
`/gallery` and `/t/:id` to the backend. Shared-tree pages receive tree-specific metadata; unlisted
trees are `noindex`. The API host is excluded from indexing. Cloudflare may add managed rules to
`public/robots.txt`; inspect the live response when checking crawler access.

Remaining search work: product-specific social cards, a public-tree sitemap, font preloads and
full landing prerendering. Hash routes cannot be independently indexed. Organization social links
and per-quest landing pages have no implementation here.

## Appearance and boot

`shell/appearance.js` stores the device preference and exposes it through `useAppearance`.
The app account menu offers Light, Dark and System; landing and static-page controls offer Light
and Dark. Browser chrome metadata follows the active room or landing and is restored on unmount.

`scripts/appBoot.js` stamps theme and ground colour before the bundle arrives. It reads rooms from
`shell/products.js` and colours from shared tokens, failing when declarations drift. App rooms hide
the no-JS fallback; landings and static pages retain theirs. `test/boot.test.mjs` exercises the
emitted script.

## Production

Production uses one origin: Caddy routes `/v1`, `/mcp` and `/oauth` to the backend. API requests are
relative and collaboration sockets use the page's `ws(s)` origin. `VITE_API_BASE_URL` overrides
this only for preview builds.

`.github/workflows/web.yml` builds and rsyncs `dist/` on trusted runs. On a fresh host, web must
land before backend deployment because the embedder mounts weights from the web directory.
See [embedder operations](../services/embedder/README.md).
