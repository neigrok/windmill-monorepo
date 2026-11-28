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

The canvas draws the replica this tab draws (`useSyncReplica`): while the shell has settled an account the engine's
replica is not bound to, as when another tab signed someone else in, it draws nothing of that replica until the shell
catches up. A page restored from the back/forward cache keeps the canvas, what was typed and its scroll; a save that came
due while the page was suspended lands once the engine is restored, unless another tab moved the seat meanwhile: what is
typed belongs to the seat it was typed under (its binding, which a re-identify keeps), so that save is refused
(`ReplicaChanged`) and lands in no other seat. `test/products/journal/boot.browser.test.js` boots the shell over a seeded
browser copy in Chromium and proves all three. A save a seat change refuses, this tab's own sign-in included, leaves its
words on the screen, unsaved: only the person's next change saves them, under the seat that stands
(`test/products/journal/browser.test.js`).

Typing shows at once and commits 600 ms after the last keystroke, one save for the burst. A mood or
energy change, the page hiding and the editor unmounting save a staged body at once; a local day
change carries it into today and saves it.
The editor saves what it holds as typed: a page the device holds as `spoken` stays spoken under it
(`PageDocument.keepingSpoken`), and a page emptied of words goes as typed. Words carried into a new day are
typed on its page, which is `spoken` only when Talk has written into it.

An anonymous save, or typing before an account's first read without a confirmed page, queues a
receipt-protected contribution claim. Anonymous replacements retain cumulative retirements.
Binding and terminal refusals retain edits under the original receipt; they cannot enqueue a new
claim. Reconciliation requires both the result and a same-epoch, digest-checked covering pull; one a sign-in or a sign-out
overtakes is refused (`ReplicaChanged`), reports nothing and runs again for the next seat.
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
binding becomes active, once any sign-in or sign-out question is answered, under a browser lock a tab that finds taken
leaves to the tab holding it, and is pinned to the engine's active binding, so a sign-in or a sign-out between two acts
ends it. A day's page (an owed page before the account's copy, an owed page never read before one read, then the newer
stamp) is claimed under an id its day and words derive, so carrying it twice writes it once, and joins the account's
page of the day as every claim does, whether or not the replica has pulled it. A page of a day this browser already
holds work of (a queued write, a claim or the editor's draft of the day), and each other page of the day with other
words, is kept as a draft to recover, so a later save of the day cannot supersede it; words past a claim's bound become
the editor's draft where its day is free, a draft to recover otherwise. An account's copies of its own pages are not
carried: the pull brings them, and they leave the store at the run's start. The first act retires the first run's
invitations for a seat with written pages, and each act records every page of it last in the seat's ledger, the
replica's device row `carry:<seat>`. As each act commits, its pages leave their stores, so a run that stops between acts
leaves only what is still owed, and no page reaches two replicas. A store is read afresh each time and gives up pages by
their day and words: a page another writer changed since has other words and stays. An act the domain refuses, or one
that fails, ends the run with its pages and those after it still in their stores. An entry that does not read (no
calendar day, a stamp that does not read, words no digest can name, such as a lone surrogate) stays in its store,
reported once a load, while the pages beside it carry, and a browser that refuses its storage opens the journal all the
same. Before the seat changes (a sign-in, a sign-out's Keep or Discard, the
account's closure), the route's `seatWillChange` (`settleSeat`) takes from the active seat's stores every page its
replica's ledger records, so a Discard takes the old pages it counted, as the claims and drafts they were carried into,
and no other: the pages not yet carried, and the entries that do not read, wait for that seat's next replica. An account's
closure then deletes every store of its seat, carried or not, the entries that do not read among them (the route's
`forgetDevice`, which the shell tells `closed`): the account no longer exists.

The pages that bundle could not attribute (`.unclaimed`, the owed pages of its first version's unscoped store, and the
pages returned from the engine's metadata below) stay in the browser's storage, which is their only record, and Settings
offers them on both seats: Restore, which takes an account, claims them into the account's replica through the runner, joined onto
that day's page as a claim is, each other page of a day as a draft to recover, each act's pages leaving their stores as
it commits; Discard deletes the pages Settings listed, and no page that arrived since, and writes nothing to the engine.
The first version's unscoped store also cached an account's pages beside the writes it owed: those copies are neither
listed nor restored, and go with their store. Settings shows the day and length of each page, never the words. No
account can be shown to own them, so every sign-out that finishes, Keep or Discard, forgets them (the route's
`forgetDevice`, `forgetUnclaimedPages`): every store of them is deleted whole, the entries that do not read and the cached
copies among them, so the next person to sign in on this browser is not offered them; a Restore made before the sign-out
is in the account's replica by then, and a sign-in forgets nothing. A browser that ran the journal's first bundle on the engine
kept those pages and its migration's records in the engine's device metadata; the carry returns the pages to the
browser's storage once, a store a page, drops from the old stores the entries those records show carried, and deletes
the three keys in the engine's one door to its metadata. A sign-out forgets the pages the metadata still holds, their
return not yet done, before the stores. These are the journal's only writes of the device rather than of a replica.

Settings' export (`settings/journalExport.js`) is one Markdown file of the room's written pages as
the room shows them, read from the replica: signed out the browser's own, and on a bound replica, once
the engine's first pull of `self/journal` ends, the account's pages with this browser's unsent saves,
refusal-held words and editor draft in their day's place. It fails after 30 seconds without that pull,
and fails rather than export another account's pages when the account changes while it waits. It asks
the backend for nothing. Settings shows it on both seats and counts those pages before anything is pressed, at once signed
out and on a bound replica once that first pull ends; where there are none it offers no export, and an export that finds
none hands the browser no file.

Search (`search/`) indexes the corpus on the device: words first, then meaning, bge-small-en-v1.5 q8
in a worker on wasm, never WebGPU, which miscomputes the quantized model. The worker takes its
onnxruntime-web runtime from the build, where Vite copies the package's wasm as a hashed asset, and
its weights from `/models/`; `public/sw.js` keeps the runtime in its asset cache and the weights in
`windmill-models-v1` after first use, and neither joins the offline shell. One opening of search
starts one model worker however often the pages change while it is open, and closing it ends the
worker, so the next opening tries afresh and a connection that comes back brings meaning back. Offline is
the engine's word on the connection, an unreachable server included, which signed out it learns from the shell's reads
of the account. Offline before its first use in
this browser (remembered under `windmill:journal-search-meaning`), the search's foot says search by
meaning needs a connection the first time; a browser where it came up before and that keeps it no
longer answers in words, with the words-only foot. The service worker keeps no redirected answer,
drops an older `windmill-models-*` cache at every activation, and tells the pages it controls when the
browser would not keep the weights.
`test/products/journal/search/neuralOffline.browser.test.js` builds the app and proves in Chromium
that meaning works offline after its first use, says it needs a connection before it, signed out with the server out of
reach and the browser online too, reporting nothing to Sentry, comes back with the connection, and leaves the shell
without its worker and runtime; it is skipped when
`public/models` lacks the weights, which `npm run build`'s `prebuild` fetches.

Echo quotations compare in NFC; saved writing retains its original bytes. The domain matcher
returns whole-grapheme UTF-16 ranges in the current source, with segmentation supplied by the
echoes boundary. Read rechecks that source before navigating, and equivalent quotation spellings
share one arrival identity.

The domain runner claims all four shared journal files: 203 comparisons, with every value/action
scene also run in reverse record order. Engine and Chromium tests exercise transaction aborts,
restart, offline writing, receipt arrival order and multiple tabs.

`npm run test:journal:server -- /absolute/backend/build` runs eleven journal Playwright acceptance
cases on ports 8094/5181 with its own database and `schema.sql`. Build `windmill_server` using
`backend/RUNNING.md` first. It requires Postgres client tools (`/tmp` on macOS), stops its listeners
by port and drops its database. `WM_E2E_PORT`, `WM_E2E_WEB_PORT` and `WM_E2E_DB_PREFIX` select isolated
backend/web ports and a database prefix. Cases cover offline convergence, Settings' export signed out, claim choices, the carry of
an owed page from before the engine, current-session Keep/Discard, account closure, and two-tab account identity protection. Account
flows wait for completed sign-out before navigating. The same script works in CI with a backend
binary and Postgres tools; the web workflow runs the complete tests/build without a backend-stack step.
