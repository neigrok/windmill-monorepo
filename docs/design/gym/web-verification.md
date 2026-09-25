# Gym web verification

The acceptance inventory is [web-build-contract.md](web-build-contract.md). All 102 Figma boards are Built after comparison with the running desktop and narrow screens, with additional Daylight coverage. This record describes checks run on 25 September 2026; release results are recorded below.

## Local fixtures

The local Postgres-backed server and Vite use ports 8088 and 5173. Verification uses isolated accounts, a separate headless browser profile, and no model requests.

- The eight-workout fixture spans 2024–2026: 30 working sets, 234 reps, and 10,560 kg external volume. Two routines and one private Note accompany it.
- The density account contains 982 workouts, 2,952 sets, and 22,638 reps. It is separate from the eight-workout fixture.
- A deterministic stored Coach conversation contains a pending proposal to change Bench Press in Push A. It supports decision and receipt checks without generating a model answer.

## Evidence

The full `npm run build` passes 1,826 web tests with zero failures or skipped cases, builds the Vite production bundle and emits all three asserted landing shells and the sitemap. The release log is `/private/tmp/windmill-gym-web-verify/web-release-build-final.log`.

Seventeen live history and sharing assertions pass: authenticated history; complete totals across keyset pages; date scope; public snapshot reads; absence of private fields; range confinement; immutable snapshots after an owner correction; live updates; exact request replay; changed-payload refusal; revocation; and revoked-ID refusal.

The complete rebuilt backend suite passes with PostgreSQL enabled: domain 973/973, MCP 273/273, adapters 1,028/1,028. All three report zero skipped cases and zero failures.

Seven live correction checks pass against the rebuilt server: complete metadata/set replacement, unchanged living routine and frozen plan, rollback on invalid rows, changed-request refusal and ownership, current-truth replay after a later correction, overlap refusal without partial writes, and no resurrection after deletion.

The 982-workout history read returned 50 rows with complete totals in 81 ms. Its 2024 filter returned the complete 366-workout totals and 50 rows in 17 ms. These are single local observations, not production performance guarantees.

## Review observations

- All app rooms use one shared header. Product navigation and gym measures remain in the gym module; Coach derives its available height from the room and product tabs.
- Owner and recipient history must share filtering and reader primitives while keeping recipient data restricted by the server.
- Full-workout correction requires one atomic request and a stable request identity; independently saving edited sets does not satisfy its Save action.
- Correction parsing preserves valid historical values and exact timestamps, including ambiguous DST instants. Progress reads use request epochs so late responses cannot replace newer facts.
- Public reader primitives take an explicit kilogram unit; an owner’s pounds preference cannot change shared labels or values.
- The shared Daylight PR token is `gold700` (`#6E5217`), with at least 4.60:1 contrast on tested Gym surfaces. Figma’s Gym library is published with no pending changes.

## Release

Frontend commit `dd41d93d` has passed [Web Deploy](https://github.com/neigrok/windmill-monorepo/actions/runs/36121339512), including all 1,826 tests with zero failures or skips. The backend commit `ba94a169` has passed [Backend CI/CD](https://github.com/neigrok/windmill-monorepo/actions/runs/36112378351) and [Deploy to VPS](https://github.com/neigrok/windmill-monorepo/actions/runs/36113038295).

Read-only production verification at `https://windmill.works/app/gym` confirms the deployed
`index-DMljCTtL.js` bundle and shared 52px header, visible brand mark, centered four-room
navigation and avatar. The signed-out page passes desktop and 320px checks with no horizontal
overflow. At 320px the mark occupies x12–44, room links x54.93–265.07 and avatar x278–308.
The authenticated behavior is covered by the isolated local checks below.

[Android CI](https://github.com/neigrok/windmill-monorepo/actions/runs/36112378254) also passes. [iOS CI](https://github.com/neigrok/windmill-monorepo/actions/runs/36112378273) builds the app and passes crash-report tests, but its package suite fails `RoutineReadoutTests.testTheUnreadHistoryLineIsTheOneTheOtherPhoneDraws`. That test searches Android source for a routine-history sentence removed by the existing Android implementation. Neither native tree changes in this release. The native follow-up is recorded in dogfood node `gym-ios-retired-routine-history-test`.

## Planning, Coach, Notes and sharing checks

The focused web suites pass 116 tests covering target ladders and reordering, retained drafts after stale saves, inline proposal decisions and receipts, Coach copy gestures, Notes, share scope serialization, creation replay, anonymous pagination and the preview read gate. The held-delete routines empty-state scenario also passes. The final cleanup shares Coach navigation between the conversation and Note editor, reuses history/date/filter/progress primitives for recipients, removes retired dialog imports and source assertions, and removes duplicate planning styles.

Live browser checks at 1440 and 390 px pass for routine creation, set-by-set editing, Ramp up, a refused stale save, comparing the current revision while retaining all draft edits, and Keep both saving a separate routine without overwriting the saved original. Notes creation, editing and delayed deletion pass. Apply changes the living routine and leaves a receipt; Turn this down leaves a receipt without changing the routine. The deterministic Push A fixture is restored to its original values and pending proposal after those checks. The only browser resource errors in those runs are the deliberately triggered 409 stale-save responses.

Sharing has browser captures for setup, range/live selection, preview, link ready, anonymous recipient and revoked states at both widths. Preview reads the owner’s proposed scope without creating a link and uses a full-screen native modal with the newest workout selected on desktop and the history list open on narrow screens. Create link, anonymous read and Revoke link complete against the local server. The anonymous boot attempts return 401 from the existing account probe; the public history request succeeds.

Reproducible local scripts and captures are under `/private/tmp/windmill-gym-web-verify`: `qa-plan-coach-live.mjs`, `qa-own.mjs`, and `qa-share-own.mjs`. Desktop routines measure 105 px per card; the editor measures 640/32/420; the pending Coach proposal measures 248 px. These checks do not replace the complete per-board visual gate.

The final planning and Notes pass has paired `routines-final`, `routine-new-final`, `picker-final`, `editor-final`, and `notes-list-final` captures. The narrow routine cards measure 94 px. The planning picker shows The six in both widths, with regular name rows, trailing add markers and a text New movement action; its rows measure 56 px. A search also finds non-featured catalog movements. The editor omits routine History, shows a complete equal-target Set label, and places the disabled-save reason beside Save. Notes rows have a 16 px top gap and 15 px semibold titles.

The kilogram regression is covered by pure and rendered-reader tests. Live preview checks at both widths keep raw kilogram loads, totals and labels while the owner’s weight preference remains pounds; `share-kg-final` captures show the result. `qa-final-owned.mjs`, `qa-boundary-final.mjs`, and `qa-plan-last-states.mjs` repeat these checks with no console errors.

Final state checks cover the 180 × 98 routine menu, danger Delete treatment, an unnamed new routine after adding Bench Press and three targets, the closed narrow editor, and complete retained-draft conflict comparisons. The shared preview opens on the list in narrow view with Create link visible; selected public workouts keep the share scope and one navigation row. Conversation deletion now lives in More and retains its delayed-send/Undo behavior. The focused deletion tests and a live menu check cover that move.

The sharing theme matrix contains 60 current captures at 1440 and 390 px in Instrument and Daylight: four setup combinations, snapshot preview, active link, recipient default, open date picker with 2024 selected, filtered 2024, selected and previous workouts, zero results, owner revoked receipt, revoked recipient and the reachable preview footer. `qa-w7-theme-matrix.mjs` creates and revokes each temporary link. There are no unexpected browser errors; anonymous account probes and revoked reads return their expected 401/404 statuses. Date controls stay mounted while a changed year loads, covered by a rendered regression and the live open-picker captures.

Desktop recipient scope filters select the first matching workout when the link has no explicit selection; an explicit selection stays authoritative, and narrow filtered views keep their list. `qa-w7-last-gates.mjs` waits for both 2024 rows before capturing the open date picker, verifies June 10 as the desktop reader, and scrolls the desktop preview footer into view before capturing Create link. All four theme/width combinations pass and their temporary links are revoked.

The active-workout Coach state is verified at both widths and in both themes. `qa-coach-active-final.mjs` creates a temporary Push A workout with two logged sets, captures `coach-workout-final-{dark,light}-{1440,390}.png`, and verifies the refusal has no composer or proposal action. View workout reveals and focuses a read-only mirror built from the frozen plan and actual sets; Notes remains reachable, and saved thread messages and receipts remain readable. No model request is sent. The script finishes and deletes its temporary workout. The final focused Coach, proposal and screen-contract run passes 142 tests, including retained drafts, workout changes during deferred photo preparation/load/upload, paused retries, and ambiguous-plan mirror handling; its output is `/tmp/gym-active-final.log`.

Adversarial checks cover workout transitions across each awaited photo boundary: prepared bytes stay local, a loaded photo does not start uploading, and a completed upload does not send a question while training. The current workout state is checked after each awaited boundary before the next remote operation. Extra working sets and warmups consume no targets from another movement; the mirror ordinal comes from remaining frozen-plan slots.

## Shared app header

The gym room uses the same 52px header as Home, Roadmap and Journal: approved Windmill mark,
centered room links and a 30px account avatar. Gym tabs begin at y52; content begins at y156 on
desktop and y136 on narrow screens. Coach derives its minimum height from the available gym
root and product tabs, including the standalone route's own header.

The local PostgreSQL/backend/Vite checks use an isolated account. All four room links select
the expected route and keep the same header. Checks at 1440, 390 and 320px cover Instrument
and Daylight, account appearance controls, signed-out chrome, the three Gym tabs, and the
pushed New routine page. At 320px the mark, room links and avatar have separate bounds and
the document has no horizontal overflow. Coach ends 12px above the viewport bottom at 1440 ×
900 and 390 × 844; its composer remains visible at 320 × 740. The active-workout state and
expanded read-only mirror fit at 390px without a composer or horizontal overflow. Temporary
fixture data is removed after verification.

The full production build passes all 1,826 tests with zero failures or skips. The backend server
target rebuilds successfully. Adversarial review finds no actionable issue; the simplification
pass removes the unused shell layout variant and consolidates Coach height rules. This keeps
header geometry in the shared shell and product layout inside Gym.

Figma shell components `468:2` and `468:13` propagate to all 88 authenticated web boards. Their
content starts at y156/y136; Coach gains 28px of available height while retaining its bottom
composer position. Four final renders cover desktop Log, desktop Routines, narrow Daylight
Routines and narrow Coach; all pass visual inspection. The 14 public/preview boards and native
boards keep their own chrome. Evidence: `/tmp/windmill-gym-header-figma-final-{0,1,2,3}.png`.
