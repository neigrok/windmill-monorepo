# Flow index

Where each user flow is drawn. Each section reads left to right; every board's caption names the code
that ships it. Status lives in the Figma layer names. Roadmap on web, Journal on iOS and Gym on the web, iOS and
Android are indexed here, with the public pages.

## Roadmap · Web

Figma: separate [Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=130-2) and
[Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-2) pages.
Code: `web/src/products/roadmap/`. [Evidence and limits](design/roadmap-web-reconciliation.md).
🚀 In production identifies current flows reconciled against source and available runtime evidence.
The [reference family map](design/roadmap-web-reconciliation.md#reference-family-map) connects retained
specimens to deployed source. Superseded drawings are labeled as such; the shared step document
includes field editing and recovery, while creation alignment remains unfinished. Status does not grant new human
approval or claim every branch was exercised. Native graph lighting is a static approximation.

| Flow | Web | Web Mobile | Entry → exit |
|---|---|---|---|
| 00 · Evidence and shared references | [166:229](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=166-229) | [170:3](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-3) | Evidence key; shared Shell and Home references |
| 01 · Start a roadmap | [131:5](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=131-5) | [170:5](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-5) | Quest shelf → blank birth or paste → tree |
| 02 · Find and edit in List | — | [131:3](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=131-3) | Superseded: the product has no List; Board and Graph are the current surfaces |
| 03 · Navigate the tree | [131:4](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=131-4) | [170:8](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-8) | Focus / All steps, switcher, kinds; visitor chrome; loading/error/desktop empty |
| 04 · Edit and complete steps | [160:10](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-10) | [170:10](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-10) | Retained superseded tablet-panel/desktop-inspector specimens; ordinary step activation uses the shared document below. Completion, workspace and multi-select behavior is retained. ✅ six Kind choices and Subtasks: Web 04.01, 04.03, 04.05, 04.06; Web Mobile 04.07, 04.11 |
| 05 · Progress and feedback | [162:323](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-323) | [170:12](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-12) | Blocked/fully grown; toast and activity feedback. Retired Next up specimens are not development targets |
| 06 · Publish, browse and fork | [131:14](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=131-14) | [183:210](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-210) | Publish and copy → public gallery or visitor → fork; Make private |
| 07 · Roadmap settings | [162:282](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-282) | — | Shared product specimens: export, gated reminders and AI assistance |
| 08 · AI assistance | [185:151](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-151) | [166:230](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=166-230) | Deployed Tend is superseded as a design target by the right-side Coach; functional Coach is deferred |
| 09 · Settings branches | [184:1307](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1307) | [185:1359](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1359) | Reminder schedule/suppression and AI allowance/history; conditional gates |
| 12 · Keyboard shortcuts | [12.01–12.16](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1109-534) | [12.05–12.10](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1109-1221), [12.14–12.16](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1111-707) | Graph Mac/Windows and detected-platform Board; owner/reader; responsive reference and compact-height scroll |

### Approved shared step editor

Board cards and Graph activation open the delivered shared nonmodal read document, with inline private
Workspace and History, relationships, pinned actions and an operable Shell. Delivery is tracked in the
[Roadmap alignment subtree](https://windmill.works/#/app/t_63c2c557d482dece). The
[current interaction handoff](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1157-3166)
specifies direct node activation, plain description and shared-link data, and an unfinished Coach
placeholder. Functional Coach remains deferred. Existing steps use one inline shared-field editor,
with conflict and navigation recovery from 46/47. New step retains its separate composer;
creation alignment remains unfinished. Link-copy recovery follows section 37.

| Flow | Approved source | Entry → exit |
|---|---|---|
| 18 · Open from Board or Tree | [18](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=754-74703), [keyboard and graph focus](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=766-2400) | Card or node activation, or Enter on the focused node → shared nonmodal editor → source and focus return; bulk selection and connections keep distinct gestures |
| 19 · Edit a step | [19](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=754-74704) | Shared field → Save/Cancel; responsive editing and recovery follow 46/47 |
| 20 · Create a step | [20](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=754-74705) | New step → draft and prerequisites → create or cancel |
| 21 · Laptop workspace | [21](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=822-3609) | Board/Graph entry and focused Graph node → laptop editor |
| 22 · Coach history and actions | [22](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=832-4672) | Collapsed/expanded right sidebar and editor actions; functional Coach history and sending remain deferred |
| 27 · Mobile web | [27](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=754-74706) | Board/Graph → shared document → inline fields, private Workspace/History and Back |
| 37 · Link-copy recovery | [37.01–37.15](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1116-74911) | Copy available step link → nonmodal failure feedback → reveal/select or retry → original control |
| 40 · Tablet read document | [40.01–40.14](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1156-79681), [responsive contract](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1157-3169) | 744 px owner/reader, attached tree and keyboard states; 56 px collapsed or 280 px expanded Coach placeholder; the available product column stacks below 1000 px |
| 43 · Refused sync recovery | [43.01–43.14](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1211-104922) | Refused changes stay below the toolbar → Retry or Discard; structure recovery preserves completion Undo, while progress recovery waits for its baseline |
| 46 · Shared-field editing | [46.01–46.12](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1322-81073) | One field → sparse Save/Cancel; dirty departure → Keep editing/Discard; changed field → Load latest/Save anyway; access loss → copyable draft |
| 47 · Retained draft recovery | [47.01–47.07](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1348-81444) | Unrestorable same-document departure → content-free draft strip → View, Copy, Return or explicit Discard; account cleanup clears the tab's retained draft |

[List vocabulary](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=16-3) on Components
is marked Superseded development target. The [mobile owner editor](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=158-121)
retains a superseded tablet-panel specimen; the shared document follows sections 18/19/27/40. [AI review proposals](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=131-45)
remain on Proposals. Account, sign-in, appearance and shared settings belong to
[Shell](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf); landing pages belong to
[Marketing](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81).

### Board view · 🚀 In production

Separate [✅ Board · Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901) and
[✅ Board · Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900) pages.
Start at the [desktop Board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543)
and the [phone Board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433).
[Design brief](design/roadmap-board-proposal.md) · [Review](design/roadmap-board-review.md). The Board is shipped;
its delivered frames carry 🚀 In production. Approved follow-ups carry 🔨 while in implementation.
Outstanding design gaps are tracked in the [consistency ledger](design/consistency.md).

| Flow | Web | Web Mobile | Entry → exit |
|---|---|---|---|
| Board, complete and reset | [184:1542](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1542) · [374:4540](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=374-4540) | [183:903](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-903) · [183:904](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-904) | Board → step → Complete or Reset in place → Undo |
| Retained detail and delete specimens | [208:355](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=208-355) | [228:964](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-964) · [324:5158](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=324-5158) · [397:28207](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=397-28207) | Retained action references; the tabbed layout is superseded. The shared document above carries Workspace, History and held Delete with Undo |
| Empty, loading and recovery | [374:4540](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=374-4540) · [232:1086](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-1086) | [183:905](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-905) | Empty or complete roadmap; skeletons, load error, save failure, sync states |
| Readers and account states | [376:12774](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=376-12774) | [188:1524](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-1524) · [276:8779](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-8779) | Visitor lands on Graph (Board without WebGL2) → Board → Fork; anonymous and lapsed owners |
| Responsive and narrow widths | [377:14651](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=377-14651) | [258:4895](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-4895) · [383:18664](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=383-18664) | 744, 900, 1024 bands; 320px and dark specimens |
| Large roadmaps | [379:8923](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=379-8923) | [379:18852](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=379-18852) | 5,000 steps: counts, per-column scroll, Done collapse |
| Find, filter and sort | [387:26773](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=387-26773) | [209:2396](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=209-2396) | Find a step, filter by kind, Roadmap order or Created |
| Roadmap verbs | [260:5150](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-5150) | [258:4895](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-4895) | Verbs row on Board and Graph; phone title-tap sheet |
| View glyphs | [569:57568](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=569-57568) | [258:1397](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-1397) | One pair on every band: Board's outlined columns, Graph's branching tree |
| Create a step | [232:1086](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-1086) | [226:602](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=226-602) · [258:4749](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-4749) | New step → prerequisites picker → revealed in its column |
| Keyboard and gestures | [386:13311](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=386-13311) | [378:16260](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=378-16260) · [398:28881](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=398-28881) | Roving focus and C; swipe to complete; long-press or Select multi-select |
| Explore a branch | [294:8978](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-8978) | [292:8701](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=292-8701) | View branch → scoped Board → Graph and back |
| Long content | — | [294:10081](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-10081) | Retained long-content behavior at 390 and 320; the tabbed layout is superseded by the approved editor above |
| Activity | [260:5150](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-5150) · [527:48637](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=527-48637) | [487:12770](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=487-12770) · [527:16010](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=527-16010) | More or roadmap sheet → Activity → step |
| Waves 6–8 states | [481:23657](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=481-23657) | [487:12770](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=487-12770) | Sync states at 744, readers and Fork, Graph row and What's next, roadmap sheet, Ask AI, demo byline |
| Wave 7 sync states | [517:30937](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=517-30937) | [519:15146](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=519-15146) | Couldn't sync on Graph, at its limit, several changes, offline |
| 🚀 Follow-ups 2026-11-06 | [626:38889](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=626-38889) | [629:19778](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=629-19778) | 16.01–16.02: one Shell head from 744 in every room, signed-out seats unchanged; 16.03 and 26.04: no WebGL2 → Board with the Graph dimmed; 26.01–26.03: step menu Select → keyboard selection and the Selection bar |
| 💡 Finishing states | [544:53326](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=544-53326) | [539:16665](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=539-16665) | 15.01–15.02 and 25.01–25.02 are superseded by approved link-copy recovery 37 above; other proposals retain their own status. ✅ 15.07 and 25.04, the held delete that fails, are built |
| Tree Guide | [17 · Current handoff](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=719-42451) · [39 · Identity and inherited Guides](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1143-75474) | [38 · Owner roadmap sheet and Guide page](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1130-100932) · [42 · Unknown parent Guides](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1178-28969) | Approved entry and responsive targets; frame statuses and the alignment subtree track delivery. Owners edit their own Guide, up to 5,000 Unicode code points; inherited Guides are read-only. App-route readers can read the author’s note when present; shared routes omit it. Failed saves preserve the draft, and remote changes are disclosed before replacement. |
| ✅ 28 · A node opens a tree | [876:48881](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=876-48881) | same section: the phone boards sit beside the desktop ones | A step that opens a tree on Graph and Board → Open tree → Back to where the person came from. Attach, fork first, Detach. Inherited Guides enter through the live identity row (39) or phone roadmap sheet (38/42). Loop, empty and missing trees. Signed out on device trees. 🚀 28.01–28.12, 28.24–28.37, 28.39–28.42 and 28.47 A are built: seeing that a step opens a tree, going in and coming back, and inherited Guides through the current Guide entry. ✅ 28.13–28.23 remain approved drawing targets. Attached-tree behavior is available in the shared step document; 28.54–28.67 retain references for that behavior under superseded layouts. ✅ 28.38 is not built: a removed tree's steps go live. 28.48–28.49 are 🧪 proposals. 🚀 [28.50–28.52](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=921-52655): the tree switcher's delete confirmation names the steps in other trees that go with the tree, beside the unchanged confirmation; desktop only, the phone sheet has no delete. 🧪 28.53 is the line without numbers. Deployed attach/change/detach behavior in 28.54–28.59 and 28.61–28.66; these tabbed layouts are marked superseded: [desktop](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=943-53045) · [phone](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=947-54394). The shared step document contains a Tree section (None and +) → TreePicker, a nested dialog from 744px and a full-screen page on phones → fork first for a tree the person can only read → attached, with Undo → ⋯ with Change tree and Detach tree → detached, the mark back. 🚀 28.43–28.46, 28.60 and 28.67 · Signed out on the trees of this device: a step opens another tree on this device, counted on the device, and going in and back, attaching, changing and detaching, and the switcher's delete line with the steps it takes work among the device's trees; the picker is 28.60 and 28.67's. |

## Roadmap · iOS

Roadmap · iOS: [the room](design/ios/roadmap.md), ✅ Ready for dev, every board approved by the owner on 2026-11-21 — page [Roadmap · iOS](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=648-2) in the Roadmap file: Start here, 00 to 13 and the kit. Not built.
Roadmap Coach: [rules ✅ ruled by the owner 2026-11-08](design/roadmap-coach.md). The web's boards are on the page [Roadmap Coach](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=668-5126) in the Roadmap file; the iPhone's are [section 11](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1449-15828) of Roadmap · iOS, ✅ Ready for dev. The chat that replaces tending (Ask AI) on iOS, web desktop and web phone.

## Journal · iOS

Figma: Journal file, page [iOS](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=202-2). Code: `apps/ios/App/Sources/Journal/`. Colour roles:
[ios-redesign.md](design/ios/ios-redesign.md). The wave's [NOTE](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=252-967) holds the findings and the owner's
rulings of 2026-11-08: the room is calm and private, and mood and energy are not drawn on iOS.

| Flow | Section | Entry → exit |
|---|---|---|
| 2c · Echoes on iOS | [`207:105`](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=207-105) | The inline ink, the reader and the trail (27a–27e), replaced on the phone by 02.3P–02.5P |
| 01 · Today — the day canvas and writing | [`242:116`](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=242-116) | 🚀 In production (2026-11-08): a failed save, one quiet line on the page with Try again 01.5P — [note 253:967](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=253-967); 🗄 the tab-bar room 01.6P, 01.8P–01.12P, superseded by 05; 🧪 first open's ink notes re-aimed 01.4P; ❌ 01.1P–01.3P, 01.7P |
| 02 · Past days, echoes and history | [`242:120`](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=242-120) | A day's echo count → one sheet → a passage → Back to tonight. 🚀 In production (2026-11-08): the sheet at .medium 02.3P, at .large by year 02.4P, lowered over an opened passage 02.5P, iOS 18's sheet 02.6P — [note 253:993](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=253-993); ✅ the context menu and held delete 02.1P–02.2P, the Search tab 02.8P; 🗄 02.7P |
| 03 · Windmill One — Talk and Echoes | [`259:1850`](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=259-1850) | 🗄 Talk as a finished recording in a sheet 03.1P–03.8P, replaced by live Talk. ✅ [Live Talk](design/ios/journal-talk.md), Talk in the bottom bar → connecting → words on today's page → Stop → Undo: the bar signed in and out, with the sign-in door Talk opens, 03.11P–03.12P, the take 03.13P–03.19P, a take that ended by itself 03.20P–03.22P, a quiet bridge 03.23P, the page full 03.24P and 03.32P, who may talk 03.25P–03.27P and 03.33P, the largest text 03.28P–03.31P, and 03.1Pb, 03.2Pb and 03.7Pb in place of 03.1P, 03.2P and 03.7P — [note 340:4901](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=340-4901). 🧪 An Undo that changed nothing 03.34P. ❌ 03.9P; 🗄 03.10P |
| 04 · Windmill One — the honest teaser and the purchase | [`266:2808`](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=266-2808) | 🧪 the teaser, the store sheet and the second door 04.1P–04.8P |
| 05 · No TabView — the bottom bar | [`277:3241`](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=277-3241) | Today → Write in the bottom bar → keyboard → Done. 🚀 In production (2026-11-08): today with Write alone at the bottom bar's trailing end 05.1A, reading back with nothing shrinking 05.2P, writing with Done alone in the keyboard's bar 05.3P, the bar's one state 05.4P, the largest text 05.5P, iOS 18's classic bar 05.6P, first open's ink notes at the pencil 05.8P — [note 281:3863](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=281-3863); 🧪 Search top right 05.7P; 🗄 05.1B, 05.1C |

## Gym · Web

Figma: Gym file, page [Web](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=466-132). Code: `web/src/products/gym/`.

| Flow | Section | Entry → exit |
|---|---|---|
| 08W · Coach — the web room | [`2123:9861`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2123-9861) | 🚀 In production: one History with the phones → a turn answered here or on another device → its ends and access states; signed out, the sign-in door ([consistency.md](design/consistency.md) 12u); 🗄 08W.14, a phone's workout proposal, replaced by WD7 |
| 08W-P · Coach — proposal card and greeting | [`2128:11609`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2128-11609) | 🚀 In production: no conversation yet → the greeting (onboarding); a routine proposal → Apply or Reject → applied, rejected or out of date |
| WD1 · Start a workout | [`2150:11609`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2150-11609) | 🚀 In production (2026-11-25): Routines → Start on a routine, or an empty workout → the first movement → the rack |
| WD2 · Logging a workout | [`2150:11612`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2150-11612) | 🚀 In production (2026-11-25): the rack → Log set → rest → a set corrected in place; the tab title, favicon and pop-out stand in for a Live Activity |
| WD3 · Edit the plan, finish, hide, discard | [`2150:11615`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2150-11615) | 🚀 In production (2026-11-25): movement menu → Edit sets → Finish → the receipt → hide, or discard with Undo |
| WD4 · A workout open on another device | [`2150:11618`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2150-11618) | 🚀 In production (2026-11-25): every page draws it → continue here; a start that lost the race keeps its sets |
| WD5 · A plan edit a second tab made stale | [`2150:11621`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2150-11621) | 🚀 In production (2026-11-25): refused → Use latest or Save mine |
| WD6 · The room before its first pull | [`2150:11624`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2150-11624) | 🚀 In production (2026-11-25): Routines and The log with no Start and no records until the first pull |
| WD7 · Coach during a workout | [`2150:11627`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2150-11627) | 🚀 In production (2026-11-25): Coach beside the rack (1440) or over it as a sheet (390) → a workout proposal → Apply or Reject → applied, or out of date |
| WD8 · The gym room signed out | [`2150:11630`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2150-11630) | 🚀 In production (2026-11-25): the room on the browser's copy, The log without shares, Coach as the sign-in door, the first visit |
| WD9 · Sign-in with signed-out work | [`2150:11633`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2150-11633) | 🚀 In production (2026-11-25): the one question → Add, or Discard and its confirmation → a workout the account could not take waits in The log |
| WD10 · The default rest | [`2181:16061`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2181-16061) | 🚀 In production (2026-11-26): Settings · Your training log, signed in or signed out → Default rest and Rest sound → saved, or not saved → an open workout follows |

## Gym · iOS

Figma: Gym file, page [iOS](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-2).
Code: `apps/ios/App/Sources/Gym/`. Colour roles: [ios-redesign.md](design/ios/ios-redesign.md).
The page is the target: 🚀 marks completed delivery, 🔨 implementation, ✅ human-approved designs
ready for development, and 🚧 open design work named in the caption. Each target holds the slot and number of the board it
replaced ([consistency.md](design/consistency.md) 10o, 10p, 10q, 10r, 12a–12n).

| Flow | Section | Entry → exit |
|---|---|---|
| 00 · The room — read me, map, anatomy | [`1118:1768`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1118-1768) | Three tabs; links to Shell for first run, sign-in, You and Delete account |
| 01 · First open — Coach-led setup | [`1081:565`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-565) | Empty Gym → Coach greeting → screenshot or talk → drafts applied or rejected on their card → Start (03); Build my own → 02 |
| 02 · Routines | [`1113:1474`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1113-1474) | Routines → editor → picker → movement form → routine Save; Start → workout (03). 🚀 In production (2026-11-07): [Direction L](design/ios/routines.md), the flow from stock Form parts — list with + in the toolbar 02L.1, routine editor Form with Lift-shaped rows, EditButton and swipe-delete 02L.2–3, searchable picker with Create 02L.4, movement form sheet with Equipment and Rest pickers, Steppers, Load as a decimal field and Varied sets 02L.5–6, summary with Start pinned 02L.7, AX1 02L.8 — [note 1993:19678](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1993-19678). 🚀 In production (2026-11-08): a proposal's row → its sheet — the row's symbol by source 02L.1P, the sheet as a Form with Apply in the toolbar 02L.9P, out of date 02L.10P, a connected tool's removal asks first 02L.11P — [note 2023:21188](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2023-21188) |
| 03 · Workout | [`1114:1513`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1114-1513) | Start or reopen → the ledger, as tall as its rows up to the rack, and the rack → wheel, Fix set or Add movement → finish → Done or Share with Coach; top-corner menu → Discard. ✅ [Workout in flight](design/ios/workout-in-flight.md): static rest target, load on the decimal pad, movement menu → Edit sets or Swap (movements with nothing logged), Coach sheet, receipt → Save to routine. 🚀 In production (2026-11-07): the load is a field in both rack states and the rack rides the keyboard as one block 03.23A, the ± ladder key 03.30, ledger rows that read the plan until logged 03.34a–c — [note 1942:17441](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1942-17441); rejected directions B, N and G stay beside them marked ❌. 🚀 In production (2026-11-10, PR #86): Direction D, the decimal pad's keyboard row holding one trailing glass ✓ that lands the typed load without logging a set, 03.23D.1 and D.3–D.5 — [note 2090:22691](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2090-22691), task `iosgym_tasks/done-72-keyboard-done.md`; D.2, a text Done, is ❌ |
| 04 · Outside the app | [`1115:1576`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1115-1576) | Control Center control (opens Routines when no workout runs), Live Activity, Dynamic Island → workout (03); ✅ the static rest target (04.6), ✅ compact Lock Screen card (04.7, task 69) |
| 05 · The log, past workouts & progress | [`1116:1605`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1605) | Date-grouped chronological workout cards, separated weigh-ins and subordinate new bests → workout detail, weight correction or movement record; weight context menu → Bodyweight |
| 06 · Bodyweight | [`1116:1683`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1683) | Weigh in → compact decimal entry → full calendar → Save; Bodyweight → correct or swipe-delete |
| 07 · On this phone | [`1116:1705`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1705) | The log → inspect → fix or discard |
| 08 · Coach | [`1117:1703`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1117-1703) | Coach entry → fresh canvas; History → retained conversation; proposal applied or rejected on its card; ✅ from a workout: Coach sheet → this-workout or next-time proposal (08.54, 08.56P, 08.57). 🚀 In production (2026-11-08): the proposal card's stock pass — pending 08.2P, long 08.27P, applied 08.12P, rejected 08.13P, out of date 08.14P, this workout and next time 08.56P — [note 2023:21188](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2023-21188) |
| 09 · Notes & Connected log | [`1117:1768`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1117-1768) | You → Notes / Connected log |

First run, sign-in, You, sign out and Delete account (section 4c `47:3852`): Shell file, page [iOS](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=1-5).

The six [iOS Gym flow contracts](engineering/ios-gym-ui-flows.md) record human approval, implementation
boundaries, scoped native/backend results and the existing load-wheel responsiveness follow-up.
Current delivery status is on each linked Figma flow.

The human-approved [iOS Other compatibility states](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1572-7844)
are ✅ Ready for dev on the canonical iOS page. Dark/Light rack, signed load/Fix wheels and existing
Other equipment fields use plain headings and kg; Name/Equipment footers are removed. This does not
add an Other picker option or a target sign button. [Task 20](../androidgym_tasks/20-edit-exercise.md)
owns implementation and native acceptance.

Five sections beside the journeys draw rulings that span flows:
[R · one iOS card radius](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1811-64816), 22 pt
continuous, with the Journal file's
[R.10 · echo card](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=231-431);
[C · Coach card decisions in system glass](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1803-10580);
[W · the weigh-in as a native grouped Form](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1806-11105);
[U · a machine's load reads kg](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1814-13077) on
iOS, Android and web; and 🚀 In production (PR #86)
[L · the ledger takes the height it is given](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2074-52825)
on iOS (L.1–L.3) and Android (L.5–L.7): the ledger grows with its rows up to the room above the
rack, then scrolls with the current set in view; L.4, the card always filling to the rack, is ❌.
Build tasks: `iosgym_tasks/done-71-ledger-takes-its-height.md`, `androidgym_tasks/118-ledger-takes-its-height.md`.

## Gym · Android

Figma: Gym file, page [Android](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=56-2).
Code: `apps/android/gym/src/main/kotlin/works/windmill/gym/`. Components: Design System library,
Android page. Journeys follow the iOS page and no number names two different screens across
the phone pages; the page is the
target ([consistency.md](design/consistency.md) 11a–11aa, 12a–12s); build tasks: `androidgym_tasks/`.

| Flow | Section | Entry → exit |
|---|---|---|
| 00 · The room — read me, map, anatomy | [`1224:13091`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13091) | Three tabs (Routines · The log · Coach) under one top app bar; colour roles, transient band, native parts, navigation motion and predictive back; the workout bar above the tabs while a workout runs; the rail from 600 dp (00.9–00.10) |
| 01 · First open — Coach-led setup | [`1224:13095`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13095) | Empty Gym → Coach greeting → screenshot or talk → routines created at once, each on its card → Start (03); Build my own → 02 |
| 02 · Routines | [`1224:13099`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13099) | Routines tab → summary → Start (03); FAB → editor → picker → targets |
| 03 · Workout | [`1224:13103`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13103) | Start a routine (or the workout bar) → rack (steppers) → Fix set → Hide or Finish → receipt → workout detail (05) or Coach (08). 🚀 In production (2026-11-07): 03.34 open rows read the plan, never today’s set — [1942:53327](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1942-53327) |
| 04 · Outside the app | [`1224:13107`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13107) | Quick Settings tile (opens Routines when no workout runs), ongoing notification, Live Update chip, lock screen → workout (03) |
| 05 · The log, past workouts & progress | [`1224:13111`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13111) | The log tab → workout detail, share, discard (asks once); a movement or new-best moment → Record → Edit movement |
| 06 · Bodyweight | [`1224:13115`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13115) | Weigh in, the Bodyweight row or a weigh-in moment on The log → weigh-in sheet (decimal keyboard); Bodyweight → correct or swipe-delete |
| 07 · On this phone | [`1224:13119`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13119) | On this phone at the head of The log → list → Inspect → fix, retry, keep or discard; sign in with training on the phone → Add or Discard |
| 08 · Coach | [`1224:13123`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13123) | Coach tab → conversation → proposal opened from its card, applied or turned down on its review sheet; every change type and situation (08.15–08.31) |
| 09 · Notes & Connected log | [`1224:13127`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13127) | You → Notes / Connected log |

🚀 In production (2026-11-08) · Android nativeness wave: boards suffixed N (02.1N–02.6N, 02.5Nb, 03.1N–03.3Nk, 05.1N,
05.10N, 06.1N–06.2N, 09.1N, 09.2N) stand beside their before pictures in sections 02, 03, 05, 05.9b–05.10b, 06 and 09, each section
with a NOTE; the wave NOTE is in 03
([`2040:38794`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2040-38794)). The owner rejected 09.6N
and 06.9N on 2026-11-08 to keep the thumb-reach bottom action, and by the same ruling the commits stay at the bottom:
Fix set, the movement form, Edit movement, the weigh-in, the routine editor and the Note editor commit from a
full-width 56 dp stock pill button at their foot under a ✕ Close head, as their redrawn N boards show; signed-out Notes keeps its full-width **Sign in**.

Sign in, You, sign out and Delete account: Shell file, page [Android](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=1-6), section `33:1568`; deletion recovery D1–D6, section `116:754`.

## Marketing site

Figma: Marketing file, page [Site redesign · 2026-11-21](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=260-2508).
Written half: [marketing site](design/marketing-site-proposal.md), which holds the sitemap, the Instrument look, what is built and what is proposed, how search engines
read the pages and the strings still false.

| Section | Page | State |
|---|---|---|
| [C · Front page](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=272-2508) | `/` | In production: `web/src/shell/marketing/BrandLanding.jsx` |
| [Mark · night version](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=267-3491) | header and footer on night grounds | In production: `web/public/brand-mark-night.svg` |
| [C · Pricing](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=284-2508) | `/pricing` | In production: `web/public/pricing.html` |
| [C · Roadmap page](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=290-2508) | `/roadmap` | In production: `web/src/products/roadmap/marketing/landingPage.js` |
| [C · Journal page](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=294-2508) | `/journal` | In production: `web/src/products/journal/marketing/landingPage.js` |
| [C · Gym page](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=293-2508) | `/gym` | In production: `web/src/products/gym/marketing/landingPage.js` |
