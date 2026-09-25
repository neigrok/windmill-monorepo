# Gym web · implementation plan

The gym web implementation follows the `Web · Gym` Figma page in eight waves. Acceptance for its
102 boards is tracked in [web-build-contract.md](web-build-contract.md). The boards and [web-design.md](web-design.md) are the
spec; this plan orders the work and records the decisions every wave keeps.

## Scope

- **The design.** The Gym file's `Web · Gym` page (`466:132`): six sections (Start, Components,
  Plan, Record, Coach & Notes, Share), every state drawn at 1440 and 390. The written half is
  [web-design.md](web-design.md), [web-form.md](web-form.md) and the briefs they name.
- **Shared rules.** Room titles, back links, units, radius tokens and the absence of set kind apply
  to every screen, including past workout entry ([brief 20](briefs/20-past-workout.md)).
- **Done.** A board turns Built when the running web matches it at both widths, checked side by side
  against live data. The plan is done when no board is Ready.
- **Out of scope.** Live training stays on the phones. A full Daylight pass is its own wave (W8).

## Decisions every wave keeps

A wave that seems to need a different answer stops and asks the owner.

**Product**

- The phone owns live training. The web plans, mirrors and backfills; no web screen starts a workout.
- Honest log: nothing the lifter didn't enter reads as recorded fact, except the default hour of a
  past workout, which is stated beside Save before it is stored.
- The routine is the unit: log from it, edit it as a draft, Coach proposes against it. Logging never
  writes the plan.
- Coach only proposes, inline, with `Apply` and `Turn this down`; the message becomes the receipt.
- Cut stays cut: no set kind, no Duplicate, no rest timer, no CSV export.

**Design system**

- Type is the fourteen `Gym/Web/*` styles; a title is Baloo 2 32/40, 28/36 narrow.
  The narrow conflict comparison retains its drawn 32/40 title.
- Colour, radius, space and measure are tokens: reading measure 640, figures 420, 4px scale, card
  radius 16.
- One numeric row language ([web-form.md](web-form.md)): values edited in place, `Add set` last, `×`
  trailing, a rail of ticks, the unit named once per surface.
- One back link, above the title, naming its destination in two words at most.
- Desktop edits in a split pane, never a sheet; narrow keeps sheets.

**Architecture**

- Logic lives in pure modules with full tests; screens stay thin.
- One feature folder per area (as `backfill/`), not more files at the root of `gym/`.
- Routes are explicit and carry their origin (`?from=`), never global state.
- A multi-set write is one request whose retry is a replay (as `POST /v1/gym/sessions/import`).
- The web mirrors server rules for early feedback; the server's answer wins.

## Current implementation

The running comparison and release evidence are in [web-verification.md](web-verification.md).

| Area | Implemented behavior |
|---|---|
| Shell | Persistent rooms header and centered bottom Gym navigation, including pushed pages |
| Routines | Movement names, tick rails, contextual Log past/Delete and New routine |
| Routine editor | Desktop movements/targets split; narrow sheets; set ladders; two-version conflict recovery |
| The log | History/reader split, filters and facets, paging, date jump and density; Weigh in beside Add past workout, icon-only Share log |
| Movement record | Interactive dot chart and actual-set facts under brief 18 |
| Edit workout / fix set | Atomic whole-workout correction and inline numeric fields |
| Past workout | Stated time and duration, overlap refusal, save opens selected log reader |
| Coach | Inline Apply/Turn this down and persisted decision receipts |
| Notes | Titled editor, disclosure and shared Coach navigation |
| Sharing | Whole/range snapshot/live links, recipient preview, expiration and revocation |
| Daylight | Shared theme tokens, accessible PR ink and Gym-local component bindings |

## Waves

### Content proportion parity

The content proportion implementation covers every current board, including the 62 Ready drawings in the
[build contract](web-build-contract.md). Navigation stays fixed under F59. Current acceptance and release evidence are recorded in
[web-verification.md](web-verification.md). Implementation is divided by feature ownership:

| Area | Content contract | Acceptance evidence |
|---|---|---|
| Planning | Center focused content; use the 360/32/420 editor and 420/32/420 conflict comparison; merge pending reviews into their routine cards; group actions and spacing | All 20 Plan boards, including Daylight, empty, picker, conflict, ladder and six-set states |
| Record | Group movement information and totals; center correction forms and routine choice; preserve the meaningful past-workout split | All 42 Record boards, including saved, saving, refused values, filters and dense history |
| Coach, Notes and sharing | Content-sized desktop Apply; consistent Notes groups; centered sharing forms; shared reader geometry | All 14 Coach and 26 Share boards, including receipts, active workout, anonymous preview and recipient states |

For each board, compare a fresh Figma reference with the running page at the drawing's viewport
size and fixture state. Check both themes, content bounds, typography, control dimensions,
scroll reachability, and existing interactions. An independent diff review and simplification
pass precede the full web build and local end-to-end checks. After deployment, verify the deployed
release and assets and repeat the rendered checks against that production frontend. Ready becomes
Built only after the corresponding evidence exists; deployment alone does not establish parity.

Order: the frame every board sits in, then the log (the hub most flows land on), then what writes,
then what reads further, then what leaves the app.

| Wave | Delivers | Why here |
|---|---|---|
| W1 · Shell | Header and tabs as drawn on every gym page, pushed pages included; page measures and content start (84 on both widths) | Every board sits in it; nothing else can turn Built first |
| W2 · The log split | History index + workout reader + progress cards on desktop; narrow reader on its own screen; Saved lands in the split | Past workout, record and Coach all land here |
| W3 · Routines and editor | Routines home as drawn; editor split with the ladder pane, `Every set` / `Set by set`, picker in the pane, conflict state | The plan is the unit everything else refers to |
| W4 · Correcting | Edit workout and fix set in place with the editable number; the keypad sheet retires | Reuses the W2 reader and the past-workout number row |
| W5 · Coach and Notes | Inline proposals with receipt, review dialog deleted; composer below the conversation; active-workout refusal and mirror; note editor title and disclosure | Needs W3's routine diff and the W1 shell |
| W6 · Exploring the log | Filters that read their value, density, the 2024 date jump, the movement record's dot chart | Builds on the W2 split |
| W7 · Sharing | Log share links (snapshot / live, whole / range), revoke, the recipient's read-only log | Needs backend work and the W6 reader |
| W8 · Daylight and library | Light theme across every screen; publish verified library changes | Last, once layouts stop moving |

Each wave closes with its boards moved to Built in Figma and its ledger entries closed.

## Backend and other surfaces

- **W2, W6.** History reads by range and filter with paging, and the progress figures of brief 18,
  served by the backend rather than computed from a page of summaries.
- **W5.** Proposals already exist (`propose_routine_change`, Apply); the inline receipt needs only the
  proposal's settled state on read.
- **W7.** Log share links, scope intersection, immutable snapshots and revocation follow
  [log-exploration.md](log-exploration.md) and the shared API contract.
- **Phones.** A rule that changes meaning (wording, a new state) lands on iOS and Android in the same
  wave or gets a ledger entry naming the lag.

## How a wave ships

1. Design check: every board in scope is Ready and complete at 1440 and 390; gaps go to a designer
   first.
2. Contract: the builder lists the code changes against what ships, one line per board.
3. Build in parallel on disjoint files: backend, web, phones.
4. Adversarial review that executes its findings, then one fix pass.
5. End to end on a local stack, plus a side-by-side of every board against the running web.
6. Commit and push; watch CI and the deploy.
7. Bookkeeping: boards to Built, ledger entries closed, the dogfood tree node marked.

## Implementation choices

- The desktop movement picker occupies the editor’s right pane; narrow uses a sheet.
- A saved past workout opens the log with that workout selected.
- Catalog spelling is preserved, including `Chin Up`.
- Native time inputs follow the system’s 12- or 24-hour presentation while editing;
  resting labels use 24-hour formatting.
- The retired `Boards` page remains a separate design-led archive decision (ledger F53).
