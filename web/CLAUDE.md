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

## Localization

Copy is read through a translator from catalogs; English is the only locale.

- `platform/i18n/message.js` parses and formats the ICU MessageFormat subset. `platform/i18n/index.js`
  resolves the app locale (`navigator.languages` against `AVAILABLE_LOCALES`, else English) and exports
  `createTranslator`.
- Each owner keeps its catalog in its own `i18n/` and exports `t` from `i18n/index.js`: `shell/i18n`
  (`shell.*`), `design-system/i18n` (`ds.*`) and `products/<product>/i18n` (`roadmap.*`, `journal.*`,
  `gym.*`). A catalog is `<locale>.json`, one flat object of key to message. A file reads only its own
  owner's catalog, through `i18n/index.js`.
- To add a string, add `"gym.log.emptyTitle": "No workouts yet"` to the owner's `en.json`, import `t`
  from the owner's `i18n/index.js` and call `t('gym.log.emptyTitle')`. A key is the owner's namespace plus
  dotted camelCase segments, at most 80 characters, written as a string literal at its call site. Map an
  enum to copy with an object of `t()` calls, never a built key, and never pass `t` around or bind another
  `t`.
- A message is one whole sentence with arguments, never assembled from fragments: `Hello, {name}`,
  `{count, plural, =0 {No sets} one {# set} other {# sets}}`, `{kind, select, rest {Rest day} other {Day}}`.
  `''` is an apostrophe and `'{'` a literal brace; a lone `'` and `’` are themselves. The plural category
  comes from `Intl.PluralRules` of the app locale, never the system's.
- Formatting stays out of the translator: an argument and `#` render as `String(value)`, so the caller
  formats a number or date as it always has and passes the result. To show a formatted count, select on
  the number and show the string: `{count, plural, one {{shown} set} other {{shown} sets}}`.
- `t` returns a string, or a fragment when an argument is an element (`{ when: <strong>{day}</strong> }`).
- Outside a production build a missing key or argument throws. A production build renders the key and
  reports `i18n-missing-message` once per key per page load ([observability](OBSERVABILITY.md)).
- `test/platform/i18n/catalogs.test.mjs` checks every owner: each `t()` key is a literal its catalog holds,
  its arguments match its message, every message parses and is used, and keys carry the namespace.
  `test/platform/i18n/hardcodedCopy.test.mjs` fails on JSX text with letters and on literal copy props
  (`COPY_PROPS` in `copyAudit.mjs`) under the roots it lists; its allowlist holds brand marks only. It reads
  JSX, not strings held in plain modules.
- A second locale is a `<locale>.json` beside each `en.json`, imported in that owner's `index.js`, and one
  entry in `AVAILABLE_LOCALES`.

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

`.github/workflows/web-smoke.yml` runs `scripts/smoke-roadmap.mjs` from the deployed commit after every successful deploy of
web or the backend on main, and by hand with a base URL and a public roadmap id. It walks the demo, a public roadmap and the
landings as a signed-out reader at 390, 744 and 1440, and makes one returning visit through the service worker at 1440,
read-only, with the event intake and Sentry blocked. It fails on a page error, a console error, a failed same-origin request
other than the anonymous `/v1/me` 401, a Graph with no painted pixels, a session whose socket never got its reply, any Sentry
attempt, a `client_error` beacon, a landing the app never mounted over, or a service worker that never took the page and primed
its shell or answers a returning visit badly. `scripts/benchmark-board.mjs` measures the Board under CPU throttling; it is a
measuring tool, not a gate.

## Offline rooms and browser replicas

The auth provider opens the browser sync engine once for this document and owns cookie cleanup.
Product preparations run before networking; occupied rooms pin Add/Discard, and sign-out pins
Keep/Discard after the bounded flush. Account closure records a durable intent and discards that
account's device data without a second question, recovering interrupted cleanup before ordinary auth refresh.
`platform/sync/react.js` exports `useSyncEngine()` and
`useSyncRecords(scope)`. The anonymous journal uses record observations; Gym retains its account gate.
Gym and journal records change only through the engine; their REST clients carry server features.
The worker stages the shell and room dependencies listed by `offline-assets.json` in one verified
cache generation before promoting it; a failed update retains the previous complete shell. The build
enforces a 4 MiB precache budget. Neural search loads its worker and WASM runtime on first search use.
API/model responses bypass the worker, and bounded network navigation falls back to the cached shell.
Server features name their connection requirement in the offline state.
