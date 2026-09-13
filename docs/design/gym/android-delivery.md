# Android design delivery contract

Read from the live Figma file on 13 September 2026. This is an implementation contract, not completion evidence. The canonical file has **90 phone states**, with Kind removed and no sound/haptic set-confirmation controls.

- [Screens](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=56-2)
- [Shared components](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-3)
- [Specifications](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9987)

All waves end with a refactoring/simplification pass, adversarial review, meaningful domain/UI tests, representative emulator comparison, and an honest worklog entry. All 90 states are runtime states derived from application data, not 90 hardcoded fixture routes. Carry existing working behavior forward; failure, loading and empty behavior in Specifications also belongs to delivery.

## Wave plan

| Wave | Unique states | Deliverable and acceptance | Complexity |
|---|---:|---|---|
| 1 · Foundations | 4 | Shared token-driven controls; root navigation and Settings; remove Kind controls and set-confirmation sound/haptics. Preserve rest-target chime and ordinary system gesture cues. Roots retain current functionality while later waves refine their bodies. | Medium; shared chrome affects every route. |
| 2 · Planning | 28 | Routine list/detail/new/edit, visible menu, duplicate, independent Undo, straight/ramp/open targets and both create-movement return paths. Real arbitrary input and persistent saves. | High; target draft retention, fill arithmetic and picker context. |
| 3 · Training | 27 | Planned/free logging, queue/refusals, session walk, entry/fix, complete/partial receipts, matching readback, save as routine and public sharing. Real saved state and persistence across process/network transitions. | High; local queue and exact session identity/arithmetic. |
| 4 · Log | 8 | Refine Log root body, records, aliases, chart interaction, pagination and bodyweight entry/correction/removal. Truthful empty/failed/partial reads. | High; data-specific charts and shared weight source. |
| 5 · Coach/account | 20 | Refine Coach root body, conversation/history/read receipt, notes, review decisions, profile/sign-in/code/connected log. Real endpoints and state-dependent refusals. | High; asynchronous writes, account scopes and proposal gating. |
| 6 · Native/a11y | 3 | Daylight and both notification specimens; conditional Live Update promotion plus ordinary ongoing fallback, replay-safe actions, actual insets, IME/back/reduced-motion/TalkBack/200% text behavior across all waves. | High; OS and device behavior must be verified. |
| 7 · Simplify/release | 0 | One app-wide structural review and final simplification; no stale wrappers, dead Kind or confirmation controls; full coverage audit, Android release build and GitHub release with verified APK and honest release notes. | Cross-cutting. |

The three root frames are counted once in Wave 1; Log and Coach body behavior is completed in Waves 4 and 5. Native/a11y checks are required during every wave; Wave 6 is their full-system acceptance gate.

## Wave 1 · Figma-derived implementation specification

Design-context calls were made for Routines Home `656:6692`, Settings `669:8191`, and the three NavigationBar variants `659:6945`. The code returned by Figma is reference React/Tailwind; implementation is Kotlin/Compose using existing WindmillFont, WindmillSpace, WindmillRadius, GymSkin and product-neutral platform tokens where they already match. Figma annotations explicitly identify Nunito, Baloo 2 and JetBrains Mono as stand-ins for Android system sans/display/mono roles. Do not add web fonts solely to match those stand-ins.

### Layout and type

| Component | Verified dimensions and typography |
|---|---|
| Phone specimen | 412 × 915. The 24dp top/bottom insets are illustration values; runtime uses actual system insets, including three-button navigation. Do not render Figma status icons or the gesture pill. |
| Root app bar `657:6689` | 64dp tall; padding left20/right12; gap12. Title24sp bold, one-line visual title with full accessibility label. Text action88×48; profile target48 with centered36dp circle, initial12sp bold. |
| Back app bar `657:6694` | 64dp; same outer spacing. Native back glyph inside48dp target; title24sp bold. Honor navigation hierarchy and predictive back. |
| Session bar `659:6967` | 64dp;12dp horizontal padding/gaps. Finish64×48; title20sp bold; settings48×48. Back stays in live workout. |
| Primary/tonal/quiet `656:6699` | Min56dp high,16dp corner radius,24dp horizontal padding; label16sp bold. Primary accent/onAccent; tonal raised/ink; quiet transparent/ink. Reversible pressed color120ms. Reduced motion instantly changes state. Logger primary is64dp. |
| NavigationBar `659:6945` | Surface fill,80dp high before actual navigation inset,12dp horizontal padding. Three equal-width targets,72dp high; centered64×32 fully rounded indicator;24dp glyph;4dp gap to12sp bold persistent label. Selected indicator raised, glyph accent, label ink. Unselected glyph/label inkDim.120ms selection, no tab haptics. |
| Routine row `659:6856` | 80dp min;16dp horizontal padding;16sp bold title,13sp dim metadata;4dp copy gap. Whole row navigates; More target48. List spacing12. |
| Support row `677:10201` | Min70dp in Settings,12dp vertical padding,12dp gap; label16sp bold/22sp line-height, metadata14sp/20sp; text wraps. Optional trailing chevron only for a destination. |
| Field surface `680:107` | Native field, min56dp;20dp radius; Default/Focused/Refused. Labels and refusal text stay outside surface in form flow; grow multiline surfaces. |
| Performed row `678:10530` | Min52dp,12dp padding/gap; stored number mono14sp/18; performed mono18sp medium/23; deviation13sp/17. Native tap and accessibility deletion. |

Routines root: outer20dp, top16dp; quiet count14sp/20; list gap12. Bottom reach band has20dp top and12dp bottom inset around full-width Start logging56dp; then NavigationBar. The count/recency comes from actual loaded data. New routine is a text action, profile initial uses actual account.

Settings: back bar followed by vertically scrolling content padded20dp with20dp gaps. “At the rack”14sp bold/20 in inkDim. Units row72dp with12dp vertical padding; label16sp bold/22; segmented container152×48, fully rounded raised fill, two68×48 segments with4dp inner gap/padding. Native selected semantics must be clear. The current spec states “This phone still draws kg”; do not claim unit conversion until every weight format/input is implemented consistently. Rest timer appears with value1:30 in the fixture, then separator, Notes, Connected log, separator, Account. Values, connections and email are real state. No Sound/Haptic/Set confirmation row. Profile, connections and notes retain their real routes even before Wave 5 restyles them.

### Resolved shared palette

| Token | Instrument | Daylight |
|---|---|---|
| brand/base | #5FCDB4 | #4C4374 |
| brand/active | #3DAE95 | #2F2A46 |
| text/link | #5FCDB4 | #4C4374 |
| gym/canvas | #0B1111 | #EBE7E3 |
| gym/surface | #161C1D | #F8F6F4 |
| gym/raised | #202627 | #DFDAD5 |
| gym/sunken | #060C0C | #DFDAD5 |
| gym/line | #202627 | #D0CAC5 |
| gym/line-strong | #2A3133 | #B6AFA9 |
| gym/ink | #F1F0EB | #1A1918 |
| gym/ink-dim | #B6B5AF | #4C4744 |
| gym/ink-faint | #727771 | #625C58 |
| gym/on-accent | #1B1408 | #FFFFFF |
| gym/on-alarm | #FFFFFF | #FFFFFF |
| gym/scrim | #030606 / 72% | #1A1918 / 45% |
| state/alarm-ink | #D08268 | #A84E35 |

Use inkDim for small metadata. The faint token is insufficient on Instrument surface at small text size. Gold remains reserved for true personal records. The Figma Daylight accent remains the existing iris #4C4374; the consistency ledger's F44 must be resolved deliberately, not silently “fixed” to mint during implementation.

### Icons and assets

The current Kotlin rail maps Routines/Log/Coach to List/DateRange/Face; those glyphs **do not match** the approved design. The Figma Routines icon is a barbell, Log is an outlined record page, Coach a chat outline. Replace these mismatches.

The committed SVG files below preserve exact bytes exported by Figma MCP on 13 September 2026. Coach uses Plugin API SVG_STRING export of `659:6821` in NavigationBar `659:6945`, preserving the 24 × 24 viewBox and Material chat outline geometry. Routines and Log come from NavigationBar variants in component set `659:6945`, More from Routines Home `656:6692` (`677:10204`), and the chevron from Settings `669:8191` / Support row `677:10201`. Use these exact glyphs unless a native Material glyph is visually verified identical; any Android conversion must preserve the exported geometry. Selected glyphs use #5FCDB4 and unselected/secondary glyphs #B6B5AF in the Instrument source; runtime tint uses the corresponding resolved token.

| Asset | Preserved Figma export |
|---|---|
| Routines selected | [nav-routines-selected.svg](assets/android/nav-routines-selected.svg) |
| Routines unselected | [nav-routines.svg](assets/android/nav-routines.svg) |
| Log unselected | [nav-log.svg](assets/android/nav-log.svg) |
| Log selected | [nav-log-selected.svg](assets/android/nav-log-selected.svg) |
| Coach | [nav-coach.svg](assets/android/nav-coach.svg) |
| Routine More | [more.svg](assets/android/more.svg) |
| Support chevron | [chevron.svg](assets/android/chevron.svg) |

Root context supplies Material Code Connect glyph hints for ArrowBack and ChatBubble. Use matching Compose Material glyphs and proper auto-mirroring; confirm the screenshot, since Figma's code uses ArrowBack even for a rotated forward arrow. All nav glyphs stay24×24; the support chevron is8×14 inside its row. System status and gesture symbols remain Android-owned.

## Wave 2 · Planning detail

Design contexts were read from New routine `660:7420`, Target/Straight `673:2567`, Create/Ready `669:8631` and picker sheet `660:7110`. The existing `RoutineDraft`, `TargetEntry`, `PickerOptions` and controlled picker state already carry much of the behavior; keep them while simplifying the Compose structure. Full state ownership and behavioral bounds remain in the tables below.

| Surface | Concrete approved UI |
|---|---|
| New/edit routine | Existing shared64dp app bar,24sp title, top-right Save88×48. Scroll body20dp padding and24dp section gap. Name label14sp/20 above field with8dp gap; field18sp regular/25,16dp inset,8dp corners, surface fill and1dp line (2dp accent focused). Placeholder “Routine name”. Movements heading18sp bold/25. Do not show fabricated history or initial error prose in a fresh empty draft. |
| Routine movement row | Flat row with8dp inset and12dp gap; leading48dp reorder handle; name17sp bold/24 above target15sp/21 dim,4dp gap. One1dp separator between rows. Whole row opens target; handle performs actual native drag with Move up/Move down alternatives. Replace the current single-line bordered cards and tap-pick/tap-place-only interaction. Add movement is a quiet full-width56dp action with a plus, not a dashed card. Recent changes is shown only from actual events. |
| Target sheet | Fully expanded native sheet: surface,24dp top corners, native handle; specimen starts at y116 on915dp phone, not a fixed runtime height. Header76dp: movement22sp bold/31, context14sp/20 below, Cancel88×48 at right. Header and commit stay outside the scroll body. Keep contextual order/routine name, allow reflow rather than fixed clip. |
| Target head | “Every set”16sp bold/22; three equal-width columns with12dp gaps, labels14sp/20 and8dp field gap. At372dp content width each field is116dp×52dp. Raised fill,12dp corners,16dp horizontal padding, value18sp bold/25. Same native numeric control for head and row; values may require extra height at larger text. |
| Target ladder | “Each set”16sp bold/22 with Fill88×48 on right. Column labels Set/Reps/kg13sp/18 dim. Set-number column40dp, then12dp gaps and two roughly equal flexible fields (152/156 at reference width),52dp minimum; rows8dp gap. Add set is a centered quiet56dp action. Keep actual native numeric IME and existing Next/Done ordering; never use the rack keypad here. Bodyweight sign control must preserve accessible width by adapting the layout. |
| Target commit | Fixed footer20dp horizontal/12dp vertical padding; primary56dp with16dp radius, exact dynamic summary from target reading: “Set · 3 × 8 · 60”, “Set · 5 sets”, “Set · open”. It stays above actual IME/system insets; refusal disables it and remains by its field. Blank Sets hides the ladder and says “You decide the numbers at the rack.”; no mode-switch UI is added. |
| Movement picker | Raised native bottom sheet,28dp top corners; title24sp bold/34. Body20dp horizontal padding,8dp top,20dp section gaps. Search is56dp min, fully rounded28dp, canvas fill,16dp inset,24dp search icon,12dp gap and16sp/22 placeholder “Search movements”. “The six”14sp bold/20 dim appears only for that real section. Rows64dp min,8dp inset,12dp gap; name16sp bold/22, equipment13sp/18 below. Existing picked movements show check and cannot be added twice; others plus. Footer pins quiet Create movement56dp with20dp horizontal/8dp vertical inset. |
| Create movement | Native sheet,24dp handle region then64dp toolbar; title22sp bold/31, Cancel64×48. Form20dp horizontal/12dp top/20dp bottom padding,24dp section gap. Name as above. Equipment label14sp/20,8dp gap. Two columns and two rows: Barbell/Dumbbell then Machine/Bodyweight; each180×56 at reference width with12dp column gap and8dp row gap.12dp radius/inset/gap; native radio semantics/circles;16sp labels. Selected row has1dp accent outline and selected radio. Grow/reflow for large text. |
| Create commit | Full-width Create and add56dp,20dp horizontal/12dp vertical footer inset, above actual IME. Empty name disables. Explicit Cancel, native Back/scrim/handle restore caller and query. Routine and quick paths use the same form but different real result handling. Native text IME opens on Name; never render the drawn Gboard specimen. |

The current builder's compact mono section labels, unequally weighted target columns,64dp planning commit and horizontal name/target row differ from these specifications. The current create form's “not in the library”, “Your movement” and “How is it loaded?” become the approved title/labels above; its four tightly packed chips become the2×2 radio grid. The current picker only draws a create action in its matching-state branch; the approved footer keeps Create movement available with an empty query too. Preserve query, arbitrary typed names, equipment and draft through dismissal/recreation. A creation write must not duplicate on repeated taps, and failed creation must not manufacture a movement or discard the user's recoverable input.

Do not remove meaningful domain refusals or signed-out behavior while cleaning copy. Save is single-flight, disabled for an unchanged or unsavable routine. Name counters and inline refusals must use actual Unicode-point counts. Target head/ladder errors retain the existing ordered ownership. Routine duplication creates a new identity, keeps the copied target order and allows editing the draft; row More offers Duplicate and Delete. Each deletion still has its own9-second Undo.

Additional exact assets are exported with Plugin API SVG_STRING, with source geometry unchanged:

| Asset | Source node | Local export |
|---|---|---|
| Routine reorder handle | `660:7074` ·48×48 frame containing the drawn two-line grip | [reorder-handle.svg](assets/android/reorder-handle.svg) |
| Picker search | `660:7116` ·24×24 | [search.svg](assets/android/search.svg) |

The reorder export includes its48dp source frame and its original placement; do not scale the entire48dp image into a24dp icon. The search export is a stroked circle plus diagonal. Both use Instrument inkDim; tint with the resolved role. Native radio, plus/check and OS keyboard controls remain native; use an existing glyph only when it visually matches.

Wave2 acceptance scenarios: new empty routine→name→add/create→target→Save; existing unchanged/empty/60-point name states; straight/ramp/open and invalid101reps; shrink/grow/open draft restoration; Fill Ramp up/Match set1; reorder by drag and accessibility; duplicate→save→list; two independent deletions→Undo/settle/failure; query-preserving cancel and arbitrary successful movement creation from both routine and quick pickers. At200% text/visible IME, fields scroll, Cancel remains reachable, and primary commits stay reachable without overlaying input.

## Behavior acceptance beyond the phone frames

- **Removed controls:** no Kind selector in logger or Fix; no logging confirmation sound/haptic setting or effect. Preserve historic stored set classification/metrics unless an explicit domain migration is designed and verified. Do not reinterpret old warmup/drop data accidentally. Rest-target chime and system drag-start feedback remain allowed.
- **Navigation/rack:** Routines/Log/Coach remain persistent roots. Weight, four band-aware ladder keys, Reps and Log set stay pinned; reading scrolls. Only central reading-region movement swipes, yielding to vertical scroll and OS edges. Native Back stays in an active workout; Back/scrim/handle close sheets. Avoid nested modals: Fix keypad replaces its sheet body.
- **Undo:** destructive rows hold writes9s independently; a new deletion settles neither. Undo restores newest held row then reveals remaining Undo. Failed settle restores its row/refusal. Background cancels held windows and restores. Restored rows get fresh swipe state. Expose Delete, Move up and Move down through TalkBack; no confirmation on an action already protected by Undo.
- **Planning:** Sets1–20, reps1–100, load±500kg. Zero isn't a target. Blank Sets=open and disables other fields while retaining draft; blank reps=max, blank load=last time. Shrink/grow retains hidden rows. Only open commit drops scheme. Count error first, then rows top-to-bottom, reps before load. Numeric/decimal native IME; ± only for bodyweight planning loads. Ramp up needs>=3 rows and unequal endpoints; interpolate/snap ties away from zero. Match set1 copies through count. Name trimmed60 Unicode points, counterfrom48; Save needs name, movement and changed draft. Row More/Duplicate are approved new implementation, not feature cuts. Android expected-revision omission is an identified implementation gap requiring reconciliation.
- **Create movement:** Name+Equipment only;60 Unicode points with counterfrom48. Barbell/Dumbbell/Machine/Bodyweight. Preserve invoking picker query and routine-vs-quick context on cancel and success. Real arbitrary typing, selection, creation and persistence must work beyond fixed Meadows Row prototype.
- **Rack numeric:** first digit replaces selected starting value, buffer8 chars, comma/point accepted, decimal/sign disabled for reps. Performed reps1–99, load±500. Refused buffer remains visible and Set disabled; cancel retains old value. One specific error at a time. Planning's100-rep bound differs intentionally.
- **Queue:** count sets offered but not accepted. Retain queue order; blocked lane has owed suffix. Prefix “{n} sets are saved on this device only.” Suffix accurately distinguishes Offline, log failed, lapsed auth, and unclassified. Terminal refusal names affected set and reason. Dismissal removes only notice; retries/remint inside budget stay quiet.
- **Receipts/readback:** finish seeds same session detail before raising receipt; closing reveals that exact session. Fewer than4 working sets says “Ended early.”; otherwise “Well done.” Real PR identifies beaten mark/date, never first-ever. Push A fixture9sets2700kg; bench partials1/2/3=480/960/1440; free57.5×8=460. No partial should render full receipt or hand off the full fixture's Coach answer. Save routine on eligible free workout copies performed working sets in order and is single-flight; refuse exact failure, show kept name on success.
- **Fix/share:** stored set numbers retain gaps; frozen plan does not change. RPE unrated or6–10 by0.5. Note4000UTF8bytes, counterfrom3200, specific refusal at limit. Correct refusal owner/missing set handling. Share with Coach creates fresh “Check my last session.” only when reachable. Human share is separate, explicit, discloses contents/access/expiry; actual server expiry/revocation, busy/live/copied/revoked/refused states. No fake link.
- **Log:** count only pages loaded, no lifetime claim; old rows persist during pagination/failure. Weigh in remains pinned on Log; Bodyweight has no second entry CTA. Weight20–400kg; date today/earlier; one parse refusal. Save fully closes then refreshes Log and Bodyweight from same source. Delete closes before independent Undo; pending removal does not imply empty read. Manual points retain dates; no segment across>7days. Record supports aliases, oldest/latest/range, pan/scrub; e1RM only eligible positive-loaded sets, no estimate for assisted/zero. Chart threshold>=4sessions across>=3weeks; otherwise facts. Loading/failed reads never fabricate zeros/chart. Touch readout returns latest on release; vertical scroll still works.
- **Coach/notes:** quiet empty composer; no canned compare offer; actual allowance. Successful answer shows read receipt; history read-only, explicit new conversation. Limits and failure fragments on Specs are required: unavailable, AI ceiling, daily/burst limits, conversation full, unanswered/read failures. Notes account-owned, explicit Save;10max, title60points, trimmed body500UTF8bytes counterfrom400. Overlimit Save remains clickable and refuses (different from set note). Disclosure “Any agent you connect can read these too.” Native48dp reorder grip plus accessible alternatives; focus follows moved note; independent deletionUndo.
- **Review:** full pending diff or end-seen gates Apply; close/back stays undecided. Apply impacts next routine session only; logged sets retained. Exact server refusal, including stale proposal, no fabricated applied state. Applied/turned-down readbacks offer no second decision. Native turn-down confirmation retained. Active workout must finish before review. Full routine deletion states and unread failures are also required.
- **Account:** one account, no checkout. Native sign-in/code fields keep user value on failure; code one-use15min, resend delay30s displayed as countdown. Real connected credentials show granted scopes/dates; loading/failed never “nothing connected.” Local-unclaimed claim is explicit and uses store counts; Not mine holds9sUndo. Connected log keeps all3 grant explanations and consequential access caption.
- **Native:** request notification permissions in context; workout is user-started. Stock Live Update uses current movement, next set and count-up rest; promotion conditional on SDK/device/user state. Always retain ordinary ongoing fallback with same facts. Authenticate and validate action identity, single-flight/replay, background/process restoration and locked-device behavior; no unconditional promise of promoted display. Sheet200–240ms ease-out, set-strip220ms, removal/Undo240ms; reduced-motion no travel/scale, state retained. Actual runtime200% nonlinear font scaling, TalkBack,48dp targets,3-button/gesture insets and IME must be verified.

Specs sources: `673:9992` rack/nav; `673:9996` deletion; `673:10000` finish/share; `673:10004` theme/text; `674:3164` numeric; `674:3169` queue; `674:3174` receipt outcomes; `677:10445` fix/effort; `677:10450` movement/rest; `677:10455` motion; `678:10658` routine contracts; `688:214` Coach/Log/Account state fragments; `663:7876` motion/notifications. The10 retained computed text stress cases are not implementation screenshots and must not be copied as current UI.

## Full 90-state ownership map

Each row must ultimately receive a runtime evidence link/test scenario in worklog or a linked verification artifact. Multiple related rows may be covered by one real scenario, but every state remains accounted for.

| Wave | Figma ID | Approved state |
|---|---|---|
| 1 | [656:6692](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-6692) | Routines / Home |
| 1 | [656:6693](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-6693) | Log / History |
| 1 | [656:6695](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-6695) | Coach / Home |
| 2 | [656:6696](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-6696) | Routines / Detail |
| 2 | [660:7359](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=660-7359) | Routines / Empty |
| 2 | [660:7420](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=660-7420) | Routines / New routine |
| 2 | [656:6697](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-6697) | Routines / Edit |
| 2 | [656:6698](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-6698) | Routines / Add movement |
| 2 | [673:2567](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-2567) | Routines / Target / Straight |
| 2 | [674:3179](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=674-3179) | Routines / Target / Ramp |
| 2 | [674:3307](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=674-3307) | Routines / Target / Open |
| 2 | [674:3419](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=674-3419) | Routines / Target / Invalid reps |
| 2 | [675:2973](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=675-2973) | Routines / Target / Fill menu |
| 2 | [678:3372](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=678-3372) | Routines / Target / Ramp up |
| 2 | [678:3494](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=678-3494) | Routines / Target / Match set 1 |
| 2 | [674:3537](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=674-3537) | Routines / Edit / Ramp applied |
| 2 | [674:3563](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=674-3563) | Routines / Edit / Open applied |
| 2 | [677:9879](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=677-9879) | Routines / Edit / Empty name |
| 2 | [677:9932](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=677-9932) | Routines / Edit / Name limit |
| 2 | [676:9711](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=676-9711) | Routines / Manage / Row menu |
| 2 | [677:9825](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=677-9825) | Routines / Manage / Duplicate draft |
| 2 | [677:10061](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=677-10061) | Routines / Manage / Duplicate saved |
| 2 | [677:10114](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=677-10114) | Routines / Manage / Copy in list |
| 2 | [676:9731](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=676-9731) | Routines / Manage / Deleted · undo |
| 2 | [676:9767](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=676-9767) | Routines / Manage / Deleted · settled |
| 2 | [669:8424](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8424) | Create · Routine · Empty |
| 2 | [669:8631](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8631) | Create · Routine · Ready |
| 2 | [670:8634](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=670-8634) | Create · Added to routine |
| 2 | [669:8838](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8838) | Create · Quick · Empty |
| 2 | [669:9004](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-9004) | Create · Quick · Ready |
| 2 | [670:8693](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=670-8693) | Create · Ready to log |
| 4 | [656:6694](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=656-6694) | Log / Movement record |
| 4 | [678:11447](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=678-11447) | Record / Rename |
| 4 | [678:11551](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=678-11551) | Record / Renamed · alias kept |
| 4 | [669:8306](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8306) | Log / Bodyweight |
| 4 | [669:8329](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8329) | Log / Weigh-in sheet |
| 4 | [672:2984](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=672-2984) | Log / Correct weigh-in |
| 4 | [669:8352](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8352) | Log / Empty |
| 4 | [671:9521](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-9521) | Log · Workout removed |
| 5 | [669:8042](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8042) | Coach / Conversation · Push A |
| 5 | [680:4043](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=680-4043) | Coach / Read receipt expanded |
| 5 | [669:8099](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8099) | Coach / History |
| 5 | [678:10531](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=678-10531) | Coach / Past conversation |
| 5 | [669:8388](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8388) | Coach / Signed out |
| 5 | [669:8122](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8122) | Coach / Notes |
| 5 | [678:11011](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=678-11011) | Notes / New note |
| 5 | [669:8145](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8145) | Coach / Note editor |
| 5 | [673:9632](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9632) | Coach / Proposal waiting |
| 5 | [669:8168](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8168) | Coach / Review |
| 5 | [673:9798](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9798) | Coach / Proposal applied |
| 5 | [673:10008](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-10008) | Coach / Applied review |
| 5 | [673:9908](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9908) | Coach / Turn down confirmation |
| 5 | [673:9854](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9854) | Coach / Proposal turned down |
| 5 | [673:10101](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-10101) | Coach / Turned-down review |
| 1 | [669:8191](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8191) | Account / Gym settings |
| 5 | [669:8214](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8214) | Account / Profile |
| 5 | [669:8283](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8283) | Account / Connected log |
| 5 | [679:3916](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=679-3916) | Connected log / How this works |
| 5 | [669:8237](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8237) | Account / Sign in |
| 5 | [669:8260](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=669-8260) | Account / Email code |
| 3 | [660:7955](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=660-7955) | Train · 01 · Bench / Set 1 |
| 3 | [659:7176](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=659-7176) | Train · 02 · Bench / Set 2 |
| 3 | [659:7243](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=659-7243) | Train · 03 · Bench / Set 3 |
| 3 | [659:7310](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=659-7310) | Train · 04 · Overhead Press / 3 of 9 |
| 3 | [671:8688](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-8688) | Training · This session |
| 3 | [671:8689](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-8689) | Training · Saved offline |
| 3 | [657:29](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=657-29) | Train · 05 · Weight sheet |
| 3 | [671:9516](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-9516) | Training · Weight refused |
| 3 | [671:9517](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-9517) | Training · Reps refused |
| 3 | [662:7669](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=662-7669) | Workout / Pick movement |
| 3 | [662:7755](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=662-7755) | Workout / Free session |
| 3 | [662:7831](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=662-7831) | Workout / One set logged |
| 6 | [660:8087](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=660-8087) | Train · Daylight / Set 1 |
| 6 | [657:31](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=657-31) | Proposal · Android Live Update |
| 6 | [657:32](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=657-32) | Proposal · Ongoing notification |
| 3 | [671:8687](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-8687) | Session · Readback |
| 3 | [671:8690](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-8690) | Session · Fix set |
| 3 | [671:8691](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-8691) | Session · Fix refused |
| 3 | [671:8692](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-8692) | Session · Set removed |
| 3 | [671:9520](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-9520) | Session · Share workout |
| 3 | [660:8028](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=660-8028) | Train · Completed example / 9 sets |
| 3 | [660:7713](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=660-7713) | Train · Finish early / 1 set |
| 3 | [660:7775](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=660-7775) | Train · Finish early / 2 sets |
| 3 | [660:7837](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=660-7837) | Train · Finish early / 3 sets |
| 3 | [671:9519](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=671-9519) | Finish · Save routine |
| 3 | [673:9326](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9326) | Session · Push A / 1 set |
| 3 | [673:9400](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9400) | Session · Push A / 2 sets |
| 3 | [673:9474](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9474) | Session · Push A / 3 sets |
| 3 | [662:7907](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=662-7907) | Workout / Free session receipt |
| 3 | [673:9548](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/Windmill-Gym?node-id=673-9548) | Session · Free session |

## Verification contract

Wave-level screenshots should compare the exact intended state at reference geometry plus one small-screen/large-text variant, with real system bars. Actual system font glyphs may differ from Figma stand-ins; hierarchy, spacing, weight, contrast, navigation, controls and copy must match. Do not use screenshot dimensions as rigid runtime constraints.

Test meaningful invariants and user workflows, especially arbitrary Unicode/byte entry, undo clocks, identity/queue persistence, partial receipt arithmetic, failed writes, draft restoration, real permissions and data-dependent empty states. A green JVM suite alone does not verify native behavior. Release completion needs the built APK, install/smoke evidence, published GitHub release and downloaded-asset checksum/build version correspondence.

Delivery status: Wave 1 shared foundations, Settings and approved removals are implemented and verified. The remaining state/behavior coverage stays assigned to its wave. See [worklog.md](../../../worklog.md) for commands, native evidence and limits. Nine exact SVG exports are preserved; their roots, geometry and Instrument paint values were checked.
