# Gym web verification

The acceptance inventory is [web-build-contract.md](web-build-contract.md). All 102 Figma boards are Built after comparison with the running desktop and narrow screens, with additional Daylight coverage. This record describes checks run on 25 September 2026; release results are recorded below.

## Local fixtures

The local Postgres-backed server and Vite use ports 8088 and 5173. Verification uses isolated accounts, a separate headless browser profile, and no model requests.

- The eight-workout fixture spans 2024–2026: 30 working sets, 234 reps, and 10,560 kg external volume. Two routines and one private Note accompany it.
- The density account contains 982 workouts, 2,952 sets, and 22,638 reps. It is separate from the eight-workout fixture.
- A deterministic stored Coach conversation contains a pending proposal to change Bench Press in Push A. It supports decision and receipt checks without generating a model answer.

## Evidence

The full `npm run build` passes 1,827 web tests with zero failures or skipped cases, builds the Vite production bundle and emits all three asserted landing shells and the sitemap. The current release log is the successful [Web Deploy run](https://github.com/neigrok/windmill-monorepo/actions/runs/36124412138).

Seventeen live history and sharing assertions pass: authenticated history; complete totals across keyset pages; date scope; public snapshot reads; absence of private fields; range confinement; immutable snapshots after an owner correction; live updates; exact request replay; changed-payload refusal; revocation; and revoked-ID refusal.

The complete rebuilt backend suite passes with PostgreSQL enabled: domain 973/973, MCP 273/273, adapters 1,028/1,028. All three report zero skipped cases and zero failures.

Seven live correction checks pass against the rebuilt server: complete metadata/set replacement, unchanged living routine and frozen plan, rollback on invalid rows, changed-request refusal and ownership, current-truth replay after a later correction, overlap refusal without partial writes, and no resurrection after deletion.

The 982-workout history read returned 50 rows with complete totals in 81 ms. Its 2024 filter returned the complete 366-workout totals and 50 rows in 17 ms. These are single local observations, not production performance guarantees.

## Review observations

- All app rooms use one shared header. Product navigation and gym measures remain in the gym module; Coach fills the content scroller between the header and bottom navigation.
- Owner and recipient history must share filtering and reader primitives while keeping recipient data restricted by the server.
- Full-workout correction requires one atomic request and a stable request identity; independently saving edited sets does not satisfy its Save action.
- Correction parsing preserves valid historical values and exact timestamps, including ambiguous DST instants. Progress reads use request epochs so late responses cannot replace newer facts.
- Public reader primitives take an explicit kilogram unit; an owner’s pounds preference cannot change shared labels or values.
- The shared Daylight PR token is `gold700` (`#6E5217`), with at least 4.60:1 contrast on tested Gym surfaces. Figma’s Gym library is published with no pending changes.

## Release

Frontend commit `b5be6760` has passed [Web Deploy](https://github.com/neigrok/windmill-monorepo/actions/runs/36124412138), including all 1,827 tests with zero failures or skips. The backend commit `ba94a169` has passed [Backend CI/CD](https://github.com/neigrok/windmill-monorepo/actions/runs/36112378351) and [Deploy to VPS](https://github.com/neigrok/windmill-monorepo/actions/runs/36113038295).

Read-only production asset verification confirms `index-CtOR4frV.js` loads
`GymApp-CPx5_R0S.js` and `GymApp-Cohytv1C.css`. The Gym bundle includes adjacent weigh-in
actions and the accessible share icon; its stylesheet is byte-identical to the verified local
build. The shared header and centered bottom navigation remain unchanged. Signed-in behavior
is verified against the isolated local accounts below.

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

## Shared header and bottom navigation

The gym room uses the same 52px header as Home, Roadmap and Journal: approved Windmill mark,
centered room links and a 30px account avatar. Routines, The log and Coach form a centered
group in a 64px bottom panel. The page scrolls between the header and panel; content starts
at y84 on both desktop and narrow screens. Coach fills that scroll region, with the composer
above the bottom panel. The panel also consumes the bottom safe-area inset.

The bottom-navigation build passes all 1,827 web tests, Vite and the landing-shell/sitemap
build. The backend server target rebuilds successfully. Independent review and local checks
cover the final diff. The local account contains 12 workouts and one routine.

At 1440 × 900, the header occupies y0–52, the scroll region y52–836 and the bottom panel
y836–900. The three controls span x612.35–827.64, centered at x720. At 320 × 568, the panel
occupies y504–568 and the controls span x52.35–267.64, centered at x160, with no horizontal
overflow. Instrument and Daylight checks cover navigation, routine editing, Log and Coach;
page actions and the composer remain reachable within the bounded scroll region on short
phone screens.

The narrow Log returns to its retained 495px scroll offset after opening and leaving a short
workout reader. Discard and Undo restore the temporary workout. At 390 × 844, the Undo toast
ends at y682, the action footer starts at y694 and ends at y780, and navigation fills y780–844.
The fixture data is removed after verification.

The frame owns layout and the Log owns history scroll persistence. One content scroller and
shared panel/footer dimensions keep navigation, Coach, actions and transient feedback separate
without competing viewport offsets or scroll writers.

Both Figma shell masters and all 88 authenticated web boards retain the shared header and
place the existing navigation controls at the bottom. Every board has an explicit content
scroll region, content y84 and a 64px bottom panel. Representative desktop Log, narrow
Daylight Routines, Coach and long Log renders pass visual inspection. The 14 public/preview
boards and native designs retain their own structure. Evidence is
`/tmp/windmill-gym-bottom-figma-{0,1,2,3}.png`.

## Log entry and share controls

Weigh in sits beside Add past workout in the desktop header and narrow footer. Share log
uses the shared 20px Share2 icon in a 44px target, with an accessible name and tooltip.
Log options keep the latest bodyweight reading and density control. Both responsive entry
buttons open the same sheet and save through the existing bodyweight flow.

The full build passes all 1,827 tests, Vite, landing shells and sitemap; the backend server
target rebuilds successfully. Independent review passes after updating the three held-delete
integration cases to use the moved button. The simplification removes the unused chip
component and styles, while keeping a single sheet state and shared action styling.

Local browser checks cover Instrument and Daylight at 1440px and phone widths of 390px
and 320px. The 390px footer remains 86px high: Weigh in is 100.36px wide, Add past workout
is 249.64px wide, with an 8px gap and 54px heights. At 320px, Add past workout is 179.64px
wide; neither label wraps and there is no horizontal overflow. The footer remains above
the centered bottom navigation. A final narrow check confirms the flexible Add past workout
label is centered within 0.004px of its button midpoint.

Saving a temporary 72.5kg weigh-in updates the latest reading. Both entry buttons open their
intended screens, and the share icon opens setup without creating a link. A fresh reload
after the test run clears the development hot-reload context error; repeated navigation
and weigh-in opening add no console errors. The temporary account and its data are removed.

Figma updates cover 15 authenticated boards: nine desktop and six narrow. The shared share
action (`925:9711`) has a 44px target and 20px icon; the footer action component (`925:9720`)
keeps an 86px band, 54px buttons and an 8px gap. Instrument and temporary Daylight renders
pass visual inspection; temporary QA boards are removed. Public, native and Share-page
content keep their existing structure. Evidence is
`/tmp/windmill-gym-log-actions-figma-{0,1,2,3}.png`.
