# Web journal sync

Pages live in the browser replica (`self/journal`) and change only through the engine. `pages.js`
writes a day as a `journal.savePage` command, or as a `journal.claimPage` claim while the replica is
anonymous or before the account's first read of that day, and reads the replica back as pages
(`pagesOf`, `corpus`). `journalApi.js` holds the server features over the session cookie: echoes,
nudges, transcription and export.

The route table's `sync` group hands the engine the journal's hooks. `prepare` imports v1/v2 cached
pages and owed writes, preserving account lineages and anonymous snapshots. Durable source digests
prevent replay after a crash between the import and source deletion. Invalid/blocked storage fails
visibly and leaves source keys intact. Unattributable pages stay quarantined until an explicit restore.
The result hook records claim receipts inside the result transaction; observations reconcile edited
claims only after a covering pull. Writing a day before its first account read uses a claim,
retaining unseen prose. Terminal refusal notices keep their documents visible after reload; corrected
saves retire their older notices.

`npm run test:journal:server -- /absolute/backend/build` runs the journal Playwright acceptance on
ports 8094/5181 with its own database and `schema.sql`. Build `windmill_server` using
`backend/RUNNING.md` first. It requires Postgres client tools (`/tmp` on macOS), stops its listeners
by port and drops its database. `WM_E2E_PORT`, `WM_E2E_WEB_PORT` and `WM_E2E_DB_PREFIX` select isolated
backend/web ports and a database prefix. Its seven cases cover offline convergence, claim choices,
migration, current-session Keep/Discard and account closure that discards device data; the account
flows wait for completed sign-out before navigating. The server acceptance script is callable in CI with that same binary
and Postgres tools; the existing web workflow runs the complete tests/build, but has no backend-stack
step.
