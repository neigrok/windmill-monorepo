# Flow index

Where each user flow is drawn. Each section reads left to right; every board's caption names the code
that ships it. Status lives in the Figma layer names. Roadmap on web and Gym on iOS and Android are
indexed here.

## Roadmap · Web

Figma: separate [Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=130-2) and
[Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-2) pages.
Code: `web/src/products/roadmap/`. [Evidence and limits](design/roadmap-web-reconciliation.md).
🚀 In production identifies current flows reconciled against source and available runtime evidence.
The [25-family coverage map](design/roadmap-web-reconciliation.md#exhaustive-current-family-map)
records every current Roadmap screen/state family and validation limits. This does not grant new
human approval or claim every branch was exercised. Native graph lighting is a static approximation.

| Flow | Web | Web Mobile | Entry → exit |
|---|---|---|---|
| 00 · Evidence and shared references | [166:229](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=166-229) | [170:3](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-3) | Evidence key; shared Shell and Home references |
| 01 · Start a roadmap | [131:5](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=131-5) | [170:5](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-5) | Quest shelf → blank birth or paste → tree |
| 02 · Find and edit in List | — | [131:3](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=131-3) | Phone List → search, expand, add a need or switch tree |
| 03 · Navigate the tree | [131:4](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=131-4) | [170:8](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-8) | Focus / All steps, switcher, kinds; visitor chrome; loading/error/desktop empty |
| 04 · Edit and complete steps | [160:10](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-10) | [170:10](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-10) | Select → owner sheet or desktop inspector → completion, workspace or multi-select |
| 05 · Progress and feedback | [162:323](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-323) | [170:12](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-12) | Next up → step; blocked/fully grown; toast and activity feedback |
| 06 · Publish, browse and fork | [131:14](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=131-14) | [183:210](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-210) | Publish and copy → public gallery or visitor → fork; Make private |
| 07 · Roadmap settings | [162:282](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-282) | — | Shared product specimens: export, gated reminders and AI assistance |
| 08 · AI assistance | [185:151](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-151) | [166:230](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=166-230) | Eligible owner → mobile request input; view/share doors have independent eligibility |
| 09 · Settings branches | [184:1307](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1307) | [185:1359](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1359) | Reminder schedule/suppression and AI allowance/history; conditional gates |
| 10 · Keyboard shortcuts | [185:2501](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2501) | [188:662](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-662) | Mac/Windows; owner/reader; current responsive layout |

The reusable [mobile owner editor](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=158-121)
and [List vocabulary](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=16-3) live on
Components. [AI review proposals](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=131-45)
remain on Proposals. Account, sign-in, appearance and shared settings belong to
[Shell](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf); landing pages belong to
[Marketing](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81).

### Board view · 💡 Proposal / awaiting human review

Separate [Web Mobile proposal](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900)
and [Web proposal](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901) pages.
Main frames: [mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433),
[desktop](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543).
[Proposal notes](design/roadmap-board-proposal.md) · [Design review](design/roadmap-board-review.md).
This additional view is separate from the
reconciled implementation and is not Ready for dev.

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
| 02 · Routines | [`1113:1474`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1113-1474) | Routines → builder → picker → movement name, equipment and inline targets → Done → routine Save; Start → workout (03) |
| 03 · Workout | [`1114:1513`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1114-1513) | Start or reopen → compact ledger and rack → wheel, Fix set or Add movement → finish → Done or Share with Coach; top-corner menu → Discard |
| 04 · Outside the app | [`1115:1576`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1115-1576) | Control Center control (opens Routines when no workout runs), Live Activity, Dynamic Island → workout (03) |
| 05 · The log, past workouts & progress | [`1116:1605`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1605) | Date-grouped chronological workout cards, separated weigh-ins and subordinate new bests → workout detail, weight correction or movement record; weight context menu → Bodyweight |
| 06 · Bodyweight | [`1116:1683`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1683) | Weigh in → compact decimal entry → full calendar → Save; Bodyweight → correct or swipe-delete |
| 07 · On this phone | [`1116:1705`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1705) | The log → inspect → fix or discard |
| 08 · Coach | [`1117:1703`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1117-1703) | Coach entry → fresh canvas; History → retained conversation; proposal applied or rejected on its card |
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

## Gym · Android

Figma: Gym file, page [Android](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=56-2).
Code: `apps/android/gym/src/main/kotlin/works/windmill/gym/`. Components: Design System library,
Android page. Numbers match the iOS page where the flow matches; the page is the
target ([consistency.md](design/consistency.md) 11a–11o, 12a–12n); build tasks: `androidgym_tasks/`.

| Flow | Section | Entry → exit |
|---|---|---|
| 00 · The room — read me, map, anatomy | [`1224:13091`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13091) | Three tabs (Routines · The log · Coach) under one top app bar; colour roles, transient band, native parts; the workout bar above the tabs while a workout runs |
| 01 · First open — Coach-led setup | [`1224:13095`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13095) | Empty Gym → Coach greeting → screenshot or talk → drafts applied or rejected on their card → Start (03); Build my own → 02 |
| 02 · Routines | [`1224:13099`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13099) | Routines tab → summary → Start (03); FAB → editor → picker → targets |
| 03 · Workout | [`1224:13103`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13103) | Start a routine (or the workout bar) → rack (steppers) → Fix set → Hide or Finish → receipt → workout detail (05) or Coach (08) |
| 04 · Outside the app | [`1224:13107`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13107) | Quick Settings tile (opens Routines when no workout runs), ongoing notification, Live Update chip, lock screen → workout (03) |
| 05 · The log, past workouts & progress | [`1224:13111`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13111) | The log tab → workout detail, share, discard (asks once); a movement or new-best moment → Record → Edit movement |
| 06 · Bodyweight | [`1224:13115`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13115) | Weigh in, the Bodyweight row or a weigh-in moment on The log → weigh-in sheet (decimal keyboard); Bodyweight → correct or swipe-delete |
| 07 · On this phone | [`1224:13119`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13119) | On this phone at the head of The log → list → Inspect → fix, retry, keep or discard; sign in with training on the phone → Add or Discard |
| 08 · Coach | [`1224:13123`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13123) | Coach tab → conversation → proposal applied or rejected on its card; every change type and situation (08.15–08.31) |
| 09 · Notes & Connected log | [`1224:13127`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13127) | You → Notes / Connected log |

Sign in, You, sign out and Delete account: Shell file, page [Android](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=1-6), section `33:1568`.
