# Web journal sync

Pages live in the browser replica (`self/journal`) and change only through the engine. The pure
`domain/` owns page documents, the journal state rule book, command validation, invitation
retirements, pending claims, editor drafts, content clocks, reconciliation and echo quotation
comparisons. `pages.js` runs its actions and adapts `JournalRoom` to the web's flat page view
(`pagesOf`, `corpus`), with durable refusal notices and editor drafts overlaid. `journalApi.js`
holds the server features over the
session cookie: echoes, nudges, transcription and export.

An anonymous save, or typing before an account's first read without a confirmed page, queues a
receipt-protected contribution claim. Anonymous replacements retain cumulative retirements.
Binding and terminal refusals retain edits under the original receipt; they cannot enqueue a new
claim. Reconciliation requires both the result and a same-epoch, digest-checked covering pull.
A reconciled save commits its complete prediction, content clock, retirements and pending removal
in one transaction. Invalid writing stays in an editor draft; failed transactions retain the last
durable state and the editor keeps newer input available for retry. Pending text takes precedence
over older refusal notices. Not now retires only the invitation.

Sign-in counts device-only drafts and pins their bytes before Add or Discard. Adoption preserves
both sides of a draft collision. Displaced drafts live in the reserved device rows
`pendingClaim:__editorRecovery__<digest>` and appear under **Recovered drafts** on the canvas;
they never overlay the current page. A recovered editor follows peer corrections, while locally
typed input remains available. Notice-cleanup failure reports separately from the committed save.

`claims.js` remains the engine-level binding checked against
`packages/api-contract/sync/reference/journal/client.js` by the sync corpus. Production page
editing and reconciliation use the domain actions. The route table hands the engine the domain's
pending-work and adoption hooks and records claim receipts in the same transaction as result processing.

`migrate.js` imports v1/v2 cached pages and owed writes, preserving account lineages and anonymous
snapshots. Durable source digests prevent replay after a crash between import and source deletion.
Unreadable entries and failed storage leave source keys intact without blocking the journal from
opening. Valid entries can still migrate; oversized writing becomes an editable or recovered draft.
Distinct overlapping sources and changed source snapshots remain recoverable without another
appending claim. Unattributable pages stay quarantined until explicit restore, with alternatives
marked `recovered` so restoring them retains a draft instead of appending it to the account.
Migration's claim adapter translates the domain's validated plan.

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
backend/web ports and a database prefix. Cases cover offline convergence, claim choices, migration,
current-session Keep/Discard, account closure, and two-tab account identity protection. Account
flows wait for completed sign-out before navigating. The same script works in CI with a backend
binary and Postgres tools; the web workflow runs the complete tests/build without a backend-stack step.
