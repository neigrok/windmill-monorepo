# Web

One Vite/React superapp for roadmap, journal and gym. Brand rules are in [AGENTS.md](../AGENTS.md);
[STRUCTURE.md](../STRUCTURE.md) defines dependency direction.

## Boundaries

- `shell/` owns routing, account, billing, settings, marketing chrome and platform services.
  `shell/products.js` composes product registrations.
- `products/<product>/` owns each product's routes, UI and domain logic. Products may use shell
  platform services but cannot import another product or the `/app` chrome.
- `design-system/`, `styles/` and `telemetry/` are product-neutral.

`test/shell-boundaries.test.mjs` checks imports, product landing registrations and public entry
points. Tests mirror `src/` under `test/`.

## Navigation

`shell/navigation.js` owns the accepted location and history state. It initializes before React
mounts; route consumers subscribe with `readNavigation`/`subscribeNavigation`, never native URL
events. Indexed entries carry additive `windmillHistory: { chain, position, entryId }`; replacements
retain identity and pushes allocate it. `windmillNavigation` retains the account-page predecessor
separately.

A voluntary action uses `requestNavigation({ key, context?, run })`. The coordinator captures a
frozen `context: { kind: 'navigation' | 'sign-out' }`; omission and native history mean
`navigation`. Unknown explicit kinds throw a static TypeError. Voluntary sign-out supplies
`sign-out` before any cleanup. Guards receive that same context through `blocked(context)` and
`onBlocked({ token, context, proceed, cancel })`; existing zero-argument guards remain compatible.
Context is never inferred from a request key or mutable account state. Repeated keys keep the first
intent's context. An unblocked action runs synchronously; its promise resolves to `{ status:
'completed', value }` or `{ status: 'cancelled' }`. The first pending key wins while a guard is
registered; the same key shares its promise and other requests are cancelled. With no registered
guard, an asynchronous action does not lock later navigation: each caller retains its existing
stale-completion checks. Before its first history write, an unguarded transaction takes the current
owned history entry, including its predecessor and state. A later transaction or native acceptance
takes a new history generation; an older action cannot publish over it. The new owner also takes
responsibility for history already applied but not yet published.

`run` receives the explicit transaction for its entire compound action, including history metadata,
selection, view changes and tracking. Its writes publish together when the action completes. Nested
work receives that transaction; there is no ambient bypass. Each transaction owns its working and
applied snapshots. Exact physical entry identity is checked before each write and publication.
During restoration, queued mutations replay only when the exact origin returns.

Every active action is registered with the coordinator before execution. Success and failure use one
completion path, independent of guard ownership. A result with no navigation effects settles without
waiting for another action's traversal. Failure closes writes and drops only unapplied mutations;
already-applied history is reconciled and published after exact restoration before the result
settles. Restoration retains its own target and deadline even when the action fails. Successful
restoration wakes all active actions. Unknown fallback and disposal revoke their capabilities and
settle them; a late rejection still reports once and cannot resume navigation.

System reconciliation uses `replaceLocation`, `replaceEntry` or `updateNavigationState`; intentional
raw state resets remain resets apart from the history index. A system rewrite requested during a
transient native traversal is bound to the accepted entry and consumed only when that entry is
restored. Unknown acceptance, failed restoration or an approved departure discards that stale
rewrite; the data or security cleanup itself remains immediate. A legacy door (`#/app`, `#/settings`, …
on another path) upgrades during `App`'s render and catches the URL bar up in a layout effect; the
Shell keys its room on the accepted pathname, so a room mounted before the upgrade lands mounts again.

A product can register one identity-bound guard with `blocked`, `onBlocked` and synchronous
`onUnrestorableNavigation`. Releasing that registration cancels its unanswered decision; an admitted
action can finish after its original view unmounts. Roadmap registers its single shared-field draft through
its persistent product session provider. Indexed
native Back/Forward restores the accepted entry before asking, retains the first destination, and
uses positional traversal without replacing Forward history. Every newly observed indexed
displacement can correct the remaining distance to that immutable origin, under one deadline. Paired
events at the same entry are coalesced; no event proves that the browser's traversal queue has
drained, and later events still reconcile. Continued interference can reach the retained-draft
timeout fallback. Proceed and Cancel share one decision latch; public Cancel cannot revoke an action
after Proceed. An unexpected asynchronous failure still reports if native fallback has already
revoked its navigation capability. An unknown native entry invalidates the pending decision, retains
the product's draft through its callback before publication, and starts a fresh chain. A failed
retention callback withholds publication; restoration timeouts use the same retention boundary. The
classic History API cannot preserve the original position for an unindexed entry. Voluntary sign-out
enters through admission before any sync cleanup; forced account replacement remains outside it.

The navigation contract gate includes direct adapters and the feature wrappers that execute them.
Run it from `web/` before the full build, with a 180-second process limit and the 120-second file limit:

```sh
node --test --test-concurrency=1 --test-timeout=120000 \
  test/shell/navigationCoordinator.test.js \
  test/shell/navigation.test.js \
  test/shell/navigation.browser.test.js \
  test/shell/navigationRaces.browser.test.js \
  test/shell/App.browser.test.js \
  test/shell/auth/AuthProvider.test.js \
  test/products/journal/echoes/useEchoes.test.js \
  test/products/roadmap/paste/NewTreeBirth.test.js \
  test/products/roadmap/SkillTreeView.stepInput.browser.test.js \
  test/products/roadmap/SkillTreeView.stepRead.browser.test.js \
  test/products/roadmap/SkillTreeView.stepRecovery.browser.test.js \
  test/products/roadmap/step/StepDraftRecovery.browser.test.js
```

Keep this consumer list current when another hook, rendered door or browser host starts executing the
navigation contract; a search for direct imports alone misses those wrappers. The shared
`test/shell/navigationBrowser.mjs` fixture supplies complete URL and history behavior for hook tests.
History-state assertions include the complete expected shell metadata and preserved entry identity
alongside product fields.

## Localization

Copy is read through a translator from catalogs; English is the only locale.

- `platform/i18n/message.js` parses and formats the ICU MessageFormat subset. `platform/i18n/index.js`
  resolves the app locale (`navigator.languages` against `AVAILABLE_LOCALES`, else the first of them; in
  Node, where there is no document, always the first) and exports `createTranslator`, which needs a
  catalog for every available locale.
- Each owner keeps its copy in its own `i18n/`: `shell/i18n` (`shell.*`), `design-system/i18n` (`ds.*`)
  and `products/<product>/i18n` (`roadmap.*`, `journal.*`, `gym.*`). A catalog is a folder holding
  `index.js`, which exports `t`, and one `<locale>.json` per locale, a flat object of key to message. A file
  reads only its own owner's catalogs.
- An owner keeps a catalog per moment its files load, so a page downloads only the copy it shows.
  `i18n/entry/` holds the copy of the files the brand root loads: what the entry chunk carries (the
  shell's landing chrome and sign-in, each product's route table and landing head, and what they import,
  such as gym's runtime) and each product's brand-root scenes (`marketing/RootScenes.jsx`). `i18n/app/`
  holds the copy of the app's chrome and home: the shell's `/app` chrome and each product's home card.
  `i18n/settings/` holds the copy of the settings page: the shell's page, each product's settings sections,
  and what they import. A product's `i18n/landing/` holds the copy of its landing page (the module its
  landing head names, and what it imports). `i18n/` holds the rest and loads with the rooms. Every tier's
  `t` reads `entry/` and its own catalog, and `settings/` also reads `app/` because the page sits inside the
  app's chrome, so a word lives once, in the latest catalog every file that shows it reads: a word the
  settings page and the chrome share lives in `app/`, and a word two other moments share, such as a landing
  and its room, in `entry/`. A file imports `t` from one tier, and its strings live in the `en.json` beside that
  `index.js`; `test/shell-boundaries.test.mjs` names a file that reads the wrong one. The shell keeps
  `entry/`, `app/`, `settings/` and `i18n/`; the design system loads with the entry and keeps one catalog.
- To add a string, add `"gym.log.emptyTitle": "No workouts yet"` to the `en.json` beside the `index.js`
  your file imports `t` from (`i18n/index.js` unless the brand root, the app's chrome or home, the settings
  page or a landing loads the file) and call
  `t('gym.log.emptyTitle')`. A key is the owner's namespace plus dotted camelCase segments, at most 80
  characters, written as a string literal at its call site. Map an enum to copy with an object of `t()`
  calls, never a built key, and never pass `t` around or bind another `t`.
- The first segment after the namespace names an area. A word an owner's surfaces share in one meaning —
  Cancel, Retry, Close, Save, Undo, Untitled roadmap — lives once under `<ns>.common.*`; a word that only
  looks the same (Board's Done column, the shortcut legend's Delete key) keeps its own key. Every owner
  names its landing head's words `<ns>.landingHead.*`.
- A message is one whole sentence with arguments, never assembled from fragments: `Hello, {name}`,
  `{count, plural, =0 {No sets} one {# set} other {# sets}}`, `{kind, select, rest {Rest day} other {Day}}`.
  `''` is an apostrophe and `'{'` a literal brace; a lone `'` and `’` are themselves. The plural category
  comes from `Intl.PluralRules` of the app locale, never the system's.
- Formatting stays out of the translator: an argument and `#` render as `String(value)`, so the caller
  formats a number or date and passes the result. To show a formatted count, select on the number and
  show the string: `{count, plural, one {{shown} set} other {{shown} sets}}`.
- `t` returns a string, or a fragment when an argument is an element (`{ when: <strong>{day}</strong> }`).
  An argument passed as `null`, `undefined` or a boolean shows nothing, as `{x}` does in JSX.
- Outside a production build a missing key, an absent argument, a message that does not parse and a
  plural count that is not a number throw. A production build renders the key (for a count, the `other`
  branch) and reports `i18n-missing-message` once per key per page load ([observability](OBSERVABILITY.md)).
- `test/platform/i18n/catalogs.test.mjs` checks every owner in every locale: each `t()` key is a literal
  the catalog its file reads holds, its arguments match its message, a translation shows the arguments
  English shows, every message lives in the latest catalog every file that asks for it reads, each tier's
  `index.js` exports `catalogs` holding every key of the tiers it reads in every locale and its `t` shows
  them, no key sits in two catalogs, keys
  carry the namespace, and a file reads its catalog through one static, relative `import { t }`.
  `test/platform/i18n/hardcodedCopy.test.mjs` fails anywhere under `src/` but the showcase on JSX text with
  letters, on literal copy props (`COPY_PROPS` in `copyAudit.mjs`, also inside object and array literals
  such as a menu's `items`) and on literal `alert`, `confirm` and `prompt` sentences; its allowlist holds
  brand marks only. It reads JSX and those dialogs, not strings held in plain modules.
- A sentence one owner renders around another owner's words takes them as an argument: the shell's sync
  question shows a product's `sync.signedOutWork.counted(n)` ("3 pages"), and each owner keeps its nouns.
- Landing heads, their no-JS bodies and the legal shelf are read from catalogs at build time and escaped
  for the HTML text, attribute or JSON-LD they land in. `index.html` carries the brand root's English head
  and no-JS body, which the build pins to `shell/marketing/landingHeads.js` byte for byte.
- Static documents in `public/` (the shelf pages, the 404 and the pause page) are whole per-locale
  documents and read no catalog; a second locale adds a translated copy of each.
- The showcase (`showcase/`, the unlinked `#/showcase` gallery) is a developer surface: its copy stays
  literal and the copy guard skips it.
- A second locale is one complete `<locale>.json` beside every `en.json`, merged into `catalogs` by every
  `index.js` that reads that tier, and one entry in `AVAILABLE_LOCALES`. It holds every key: the translator falls back to no
  other locale. The rest of the work a second locale needs is tracked on the dogfood node
  `i18n-second-locale-readiness-20261109`.

## Run and build

Use the Node major selected by [web CI](../.github/workflows/web.yml), and check `node --version`
before installing or running the suite. Newer Node globals can conflict with the browser test harness.

```sh
npm run dev      # localhost:5173; development API defaults to localhost:8088
npm test         # complete Node test suite
npm run build    # fetch model weights, type-check the domain, run tests, build Vite and static landing shells
```

Use `npm run build` as the gate. `prebuild` fetches self-hosted weights into `public/models`;
`vite build` alone skips that step, tests and static-page generation.

With `APPLE_TEAM_ID` in its environment the build writes `dist/.well-known/apple-app-site-association`
(`scripts/appSiteAssociation.js`), the file iOS reads before it opens a roadmap's link in the iPhone app. Without it the
build writes no file and says so, and an identifier that is not ten capitals and digits stops the build. Web Deploy
passes the secret and holds a release that carries no file.

Web Deploy runs a pull request's suite a second time with `VITE_ROADMAP_REPLICA_ROOM=on` (its `room-on-tests` job), as
production's build sets it; `VITE_ROADMAP_REPLICA_ROOM=on npm test` runs it locally. Only Vite-served tests read the switch,
so a browser test about one reading pins `replicaRoom.js` in its fixture and says which in its name.

When Roadmap events or failure boundaries change, run the existing cheap observability audit before
browser tests and include it in the final verification gates:
`node --test --test-concurrency=1 --test-timeout=120000 test/products/roadmap/observability.test.mjs`.

`npm run test:roadmap:server -- /absolute/backend/build` drives the roadmap room's writes end to end on a local stack
(`scripts/e2e-roadmap-replica.mjs`), once with the server's roadmap engine and the room's replica switch on and once with
both off: Undo and Redo, edits made offline syncing on reconnect, a change against another device's delete, a roadmap's
deletion, a change to a roadmap another device deleted, which only the switch keeps in the account menu's Kept here, to
copy and discard, flow 50's sign-in and sign-out questions, which only the switch asks, and the carry-over of a browser
holding the old bundle's stores, which only the switch runs; with the switch on, also Settings' export from the device's
copy with no connection, readers and births: a stranger, signed out and signed in, reading a public roadmap and the subtree
its step owns, each followed as it opens and dropped on leaving; a private roadmap the room cannot load, of which the
browser keeps nothing; a browser that keeps nothing shown the load error, its bare roadmap door staying where it is; and a
roadmap born at the birth door signed out, held in the anon replica and joining at sign-in an account that holds none.
In both runs the public demo, signed out and signed in, opens, plays its coach and reads its Board and step alike; with
the switch on it reads the engine's copy, which `windmill_roadmap_adopt demo` adopts before the server starts. With the
switch on, the server's engine is on, so it answers what the move retires `410 client-update-required` (§8.3), and the run
counts the server's own refusal lines and holds that no page asked for one. Build `windmill_server` and
`windmill_roadmap_adopt` first (`backend/RUNNING.md`). It builds the app into a temporary folder, serves it on 5183 against the server on 8095
(`WM_E2E_WEB_PORT`, `WM_E2E_PORT`), uses its own databases (`WM_E2E_DB_PREFIX`), prints no id or roadmap text, and stops
and drops what it started. `WM_E2E_SHOTS` names a folder for screenshots of the kept list and flow 50's questions at 1440
and 390. The journal's twin, `test:journal:server`, is described in `src/products/journal/README.md`.

The test runner caps ordinary file concurrency at four, using one fewer than the available CPUs
with a minimum of one. This bounds concurrent browser and Vite hosts. Runtime fuzz and performance
files run separately, one at a time.
Set `WM_TEST_CONCURRENCY=1 npm test` (or `npm run build`) to lower the ordinary-worker cap locally.
The setting accepts exactly `1`, `2`, `3` or `4`; empty or invalid values fail before any tests run.
The CPU limit still applies. Omitting it preserves the default; test coverage and timeouts do not change.

`vite.config.js` checks that roadmap's `DEFAULT_KINDS` and `GENESIS_STAMP` match
`packages/api-contract/genesis.js`, preserving agreement between device and server trees.

Verify an existing build against a running local backend from the repository root:

```sh
node web/scripts/serve-built.mjs --root web/dist --port 5300 --backend http://127.0.0.1:8088 --duration 1800
```

The server binds `127.0.0.1`, serves the existing files without rebuilding and proxies `/v1`, `/mcp`,
`/oauth` and `/og/` on the same origin. The backend argument is an HTTP(S) origin without credentials,
path, query or fragment. WebSocket upgrades use fresh upstream connections because Drogon can
reject an upgrade on a connection reused after an HTTP request. Missing assets return 404; `/app`
and its extensionless descendants and `/t/:id` use the built index. Shared-tree paths verify the
frontend, not backend-rendered metadata; `/gallery` serves the built `gallery.html` when present.
The process exits after 30 minutes by default or on SIGINT/SIGTERM, closing HTTP and upgraded
connections. Readiness prints the port, resolved root and index SHA-256; requests and credentials
are never logged. This local verification tool sends no product events or Sentry reports.

## Static pages and search

`scripts/build-landing-shells.mjs` builds `/`, `/roadmap`, `/journal` and `/gym` from
`shell/marketing/landingHeads.js` and each product's `marketing/landingHead.js`. These modules
must be plain Node-readable data: no top-level JSX imports or browser globals. Each landing has
its own head and no-JS body. Shelf pages live in `public/`.

The build generates `sitemap.xml` from canonical URLs, excluding `noindex` pages; there is no
source sitemap to edit. `staticPageAssets.js` checks canonical, Open Graph and Twitter metadata
and supplies shared fonts, chrome, boot and appearance assets. Missing landing modules or fallback
bodies fail the build.

Caddy serves real 404s, redirects extensionless static paths to their canonicals, serves the
association file as JSON at its own address and forwards `/gallery` and `/t/:id` to the backend.
Shared-tree pages receive tree-specific metadata; unlisted trees are `noindex`. The API host is
excluded from indexing. Cloudflare may add managed rules to `public/robots.txt`; inspect the live
response when checking crawler access.

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

Watch every PR check with `gh pr checks <number> --watch --fail-fast --interval 45` under a bounded
process deadline. A workflow can still be running after one of its jobs has failed; filtering to
active jobs hides that failure. Confirm the check set belongs to the pushed head before merging.

`.github/workflows/web-smoke.yml` runs `scripts/smoke-roadmap.mjs` from the deployed commit after every successful deploy of
web or the backend on main, and by hand with a base URL and a public roadmap id. It walks the demo, a public roadmap and the
landings as a signed-out reader at 390, 744 and 1440, and makes one returning visit through the service worker at 1440,
read-only, with the event intake and Sentry blocked and the sync engine's pull let through as the read it is. It fails on a page
error, a console error, a failed same-origin request other than the anonymous `/v1/me` 401, a Graph with no painted pixels, a
session the server never answered, any Sentry attempt, a `client_error` beacon, a landing the app never mounted over, or a
service worker that never took the page and primed its shell or answers a returning visit badly. On a site that serves its
own API, as production does, it also fails unless `/.well-known/apple-app-site-association` answers `200` as
`application/json` with no redirect and holds what the build writes for the team it names. It calls no route roadmap's
move onto the engine retires, so it walks a server with roadmap's switch on, as production's is, or off: the step link
takes its step from the reader's Board and the roadmap's visibility from its share page, and a session is answered once
the engine has pulled the roadmap and follows it live, or, with the switch off, once the room's socket answers its
subscribe. Against a local stack (`serve-built.mjs` renders no
share page), pass the backend as `--api`. `scripts/benchmark-board.mjs` measures the Board under CPU throttling, on roadmaps
it plants through MCP (`scripts/roadmap-rig/planter.mjs`); it is a measuring tool, not a gate.

## Offline rooms and browser replicas

The auth provider opens the browser sync engine once for this document and owns cookie cleanup.
Product preparations run before networking; occupied rooms pin Add/Discard, and sign-out pins
Keep/Discard after the bounded flush. A product's `signOutNotice()` adds a line to the sign-out question, with a download
of what signing out discards from the tab (the journal's kept Talk take), and its `forgetDevice` drops it. A product's
`sync.signOutBegins(engine)` runs before the engine sends what the device holds, while the account's replica still takes
a write: gym's Coach ends its running turn there. Its `sync.signOutForgets(engine)` names, as the sign-out is decided, the
device rows the finished sign-out takes from the account's replica (`finishSignOut`'s `forgetDeviceRows`), in the write
that finishes it, so a sign-out cancelled or failed keeps them: gym's Coach names its mark and its pictures. A product's
`sync.seatWillChange(engine)` runs before the seat changes: before a sign-in binds the device to an account (one the
engine resumes as it starts included) and before a sign-out finishes, in rail order, each awaited for at most five seconds
(`DeviceSeat.willChange`); one that throws or outlasts that is reported and the seat changes without it. Gym saves each
signed-out workout for adoption there. A product may
word its own question (`sync.signInWords`; `sync.signOutWords` for a sign-out whose work is all its own and that no
notice joins): the shell then asks in those words as flow 50 draws roadmap's, a dialog from 744px and a page below, where
Escape cancels, and a cancelled sign-in signs the account out and leaves the work from before on the device. Each due
product is asked in turn. Account closure records a durable intent and discards that
account's device data without a second question, recovering interrupted cleanup before ordinary auth refresh: each
product's `forgetDevice` hears `closed` for it.
`platform/sync/react.js` exports `useSyncReplica()`, `useSyncEngine()`,
`useSyncRecords(scope)` and `useSyncNotices(product)`; records and notices follow the replica this tab draws, so no room
draws another seat's while the shell catches up. The anonymous journal uses record observations; gym's room draws from
the replica the engine holds without waiting for the account, and signed out is its sign-in pitch. A page restored from
the back/forward cache keeps every room as it stood, and its writes wait for the engine's restore, landing only under the
seat they were made under.
Gym and journal records change only through the engine; their REST clients carry server features.
The worker stages the shell and room dependencies listed by `offline-assets.json` in one verified
cache generation before promoting it; a failed update retains the previous complete shell. The build
enforces a 4 MiB precache budget. Neural search loads its worker and WASM runtime on first search use; the worker
keeps the runtime in its asset cache and the weights in `windmill-models-v1` after that use, neither in the shell.
API responses bypass the worker: its fetch handler declines them, and where the browser takes service
worker routes the worker routes `/v1/` to the network at install, so a beacon or keepalive request a page sends
as it hides never waits on the handler. Bounded network navigation falls back to the cached shell.
Server features name their connection requirement in the offline state.

Product session contributions are static `routes.session = { Provider, Notice, invalidateAccount }` entries.
`ProductSessions` mounts them above keyed routes, with Auth's read-only `DocumentDataScope`. A scope is pending
until a usable engine holder resolves, ready for that owner, or changing while committed cleanup is fenced.
Replacement and committed cleanup advance the epoch before invalidating product memory and publishing account
changes; each invalidator is isolated. Lapse and same-owner recovery retain the epoch. Completion requires the
current transition ticket and matching usable holder. `PageFrame` places actual header, session notices and
contained content in normal flow; landing headers keep their responsive height. Headerless routes and fallbacks
use the same top notice slot. Product session data never enters shell layout or navigation state. A session may offer
the `/app` account menu one row, `{ label, count, onSelect }`, through `useAccountRowOffer` while it has something to
say; the Shell reads the rows with `useOfferedAccountRows` and the seat shows a member each as its label and count.
