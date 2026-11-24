# Web journal sync

Pages live in the browser replica (`self/journal`) and change only through the engine. The pure
`domain/` owns page documents, the journal state rule book, command validation, invitation
retirements, pending claims, editor drafts, content clocks, reconciliation and echo quotation
comparisons. `pages.js` runs its actions and adapts `JournalRoom` to the web's flat page view
(`pagesOf`, `corpus`), with durable refusal notices and editor drafts overlaid. `journalApi.js`
holds the server features over the session cookie: echoes and nudges, which are the account's, so a
signed-out seat asks for neither (`useEchoes` and `useNudge` read and poll only with an account).
`talk/` is Talk: the mic and its sheet, `talkStore.js`, which holds a refused take for the tab across the room being left
and forgets it at an account change, and `talkApi.js`, the transcription and the two reads a press
makes before the microphone opens.

Only a body with non-whitespace text makes a journal day. Mood and energy alone never make a
page. Blank drafts normalize before validation; a new blank draft queues no page command, and
erasing anonymous writing cancels its claim while preserving invitation state. Clearing an account
page keeps an invisible sync ordering marker so older offline saves cannot revive it.

Typing shows at once and commits 600 ms after the last keystroke, one save for the burst. A mood or
energy change, the page hiding and the editor unmounting save a staged body at once; a local day
change carries it into today and saves it.

An anonymous save, or typing before an account's first read without a confirmed page, queues a
receipt-protected contribution claim. Anonymous replacements retain cumulative retirements.
Binding and terminal refusals retain edits under the original receipt; they cannot enqueue a new
claim. Reconciliation requires both the result and a same-epoch, digest-checked covering pull.
A reconciled save commits its complete prediction, content clock, retirements and pending removal
in one transaction. Invalid writing stays in an editor draft; failed transactions retain the last
durable state and the editor keeps newer input available for retry. Pending text takes precedence
over older refusal notices; a save dismisses its day's earlier notices in one write through the
runner's replica port (`dismissNotices`), which reads the journal's device rows and keeps them all while
a refused claim of that day still speaks for its words. Not now retires only the invitation.

Sign-in counts written days and preserves device-only drafts; the engine pins their bytes before
Add or Discard. Device work without writing adopts automatically, including invitation state and
legacy blank claims, without an empty personal-data question. A blank legacy claim preserves an
account page's writing, scores and source. Adoption preserves
both sides of a draft collision. Displaced drafts live in the reserved device rows
`pendingClaim:__editorRecovery__<digest>` and appear under **Recovered drafts** on the canvas;
they never overlay the current page. A recovered editor follows peer corrections, while locally
typed input remains available. Notice-cleanup failure reports separately from the committed save.

`claims.js` remains the engine-level binding checked against
`packages/api-contract/sync/reference/journal/client.js` by the sync corpus. Production page
editing and reconciliation use the domain actions. The route table hands the engine the domain's
pending-work and adoption hooks and records claim receipts in the same transaction as result processing.

`carry.js` carries what the journal's bundle before the engine kept in this browser's storage, a store a key, into
the replica (web-device-parity §5), through the domain's actions (`domain/carry.js`). A seat's pages go only into
their own replica while it is active: an account's (`wm.journal.*.u.<id>`) into that account's bound replica, the
pages written signed out (`.anon`) into the anon replica; a run starts on every load and again whenever another
binding becomes active, under a browser lock a tab that finds taken leaves to the tab holding it, and is pinned to the
engine's active binding, so a sign-in or a sign-out between ends it with every store whole. A day's page (an owed page
before the account's copy, an owed page never read before one read, then the newer stamp) is claimed under an id its
day and words derive, so carrying it twice writes it once, and joins the account's page of the day as every claim does,
whether or not the replica has pulled it. A page of a day this browser already holds work of (a queued write, a claim
or the editor's draft of the day), and each other page of the day with other words, is kept as a draft to recover, so
a later save of the day cannot supersede it; words past a claim's bound become the editor's draft where its day is
free, a draft to recover otherwise. An account's copies of its own pages are not carried: the pull
brings them. The first act retires the first run's invitations for a seat with written pages, and each act records its
pages last in the seat's ledger, the replica's device row `carry:<seat>`; a store goes once its acts are written, and
only while it holds the bytes that were read. An entry that does not read stays in its store, reported once a load, and
a browser that refuses its storage opens the journal all the same. A device held in memory carries nothing. A sign-out's
Discard, or the account's closure, that takes an account's replica takes that account's stores too (`forgetSeat`, from
`forgetDevice`); a Keep leaves them for its next sign-in.

The pages that bundle could not attribute (`.unclaimed`, and its first version's unscoped store) stay in the
browser's storage, which is their only record, and the signed-in person decides in Settings: Restore claims them into
the account's replica through the runner, joined onto that day's page as a claim is, each other page of a day as a draft
to recover, and deletes each store once its acts are written; Discard deletes them and writes nothing to the engine. A
sign-out leaves them for whoever is at the browser next, who sees the day and length of each, never the words. A
browser that ran the journal's first bundle on the engine kept those pages and its migration's records in the engine's
device metadata; the carry returns the pages to the browser's storage once, a store a page, drops from the old stores
the entries those records show carried, and deletes the three keys in the engine's one door to its metadata, the
journal's only write of the device rather than of a replica.

Settings' export (`settings/journalExport.js`) is one Markdown file of the room's written pages as
the room shows them, read from the replica: signed out the browser's own, and on a bound replica, once
the engine's first pull of `self/journal` ends, the account's pages with this browser's unsent saves,
refusal-held words and editor draft in their day's place. It fails after 30 seconds without that pull,
and fails rather than export another account's pages when the account changes while it waits. It asks
the backend for nothing.

Search (`search/`) indexes the corpus on the device: words first, then meaning, bge-small-en-v1.5 q8
in a worker on wasm, never WebGPU, which miscomputes the quantized model. The worker takes its
onnxruntime-web runtime from the build, where Vite copies the package's wasm as a hashed asset, and
its weights from `/models/`; `public/sw.js` keeps the runtime in its asset cache and the weights in
`windmill-models-v1` after first use, and neither joins the offline shell. One opening of search
starts one model worker however often the pages change while it is open, and closing it ends the
worker, so the next opening tries afresh and a connection that comes back brings meaning back. Offline is
the engine's word on the connection, an unreachable server included. Offline before its first use in
this browser (remembered under `windmill:journal-search-meaning`), the search's foot says search by
meaning needs a connection the first time; a browser where it came up before and that keeps it no
longer answers in words, with the words-only foot. The service worker keeps no redirected answer,
drops an older `windmill-models-*` cache at every activation, and tells the pages it controls when the
browser would not keep the weights.
`test/products/journal/search/neuralOffline.browser.test.js` builds the app and proves in Chromium
that meaning works offline after its first use, says it needs a connection before it, comes back with
the connection, and leaves the shell without its worker and runtime; it is skipped when
`public/models` lacks the weights, which `npm run build`'s `prebuild` fetches.

Echo quotations compare in NFC; saved writing retains its original bytes. The domain matcher
returns whole-grapheme UTF-16 ranges in the current source, with segmentation supplied by the
echoes boundary. Read rechecks that source before navigating, and equivalent quotation spellings
share one arrival identity.

The domain runner claims all four shared journal files: 203 comparisons, with every value/action
scene also run in reverse record order. Engine and Chromium tests exercise transaction aborts,
restart, offline writing, receipt arrival order and multiple tabs.

`npm run test:journal:server -- /absolute/backend/build` runs eight journal Playwright acceptance
cases on ports 8094/5181 with its own database and `schema.sql`. Build `windmill_server` using
`backend/RUNNING.md` first. It requires Postgres client tools (`/tmp` on macOS), stops its listeners
by port and drops its database. `WM_E2E_PORT`, `WM_E2E_WEB_PORT` and `WM_E2E_DB_PREFIX` select isolated
backend/web ports and a database prefix. Cases cover offline convergence, claim choices, the carry of an owed page
from before the engine, current-session Keep/Discard, account closure, and two-tab account identity protection. Account
flows wait for completed sign-out before navigating. The same script works in CI with a backend
binary and Postgres tools; the web workflow runs the complete tests/build without a backend-stack step.
