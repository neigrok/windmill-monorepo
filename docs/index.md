# Flow index

Where each user flow is drawn. Each section reads left to right; every board's caption names the code
that ships it. Status lives in the Figma layer names. Gym on iOS and Android is indexed here so far.

## Gym · iOS

Figma: Gym file, page [iOS](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-2).
Code: `apps/ios/App/Sources/Gym/`. Colour roles: [ios-redesign.md](design/ios/ios-redesign.md).
The page is the target: 🚀 boards match the app, 🚧 boards are what the next build draws, and each
target holds the slot and number of the board it replaced ([consistency.md](design/consistency.md)
10o, 10p, 10q, 10r).

| Flow | Section | Entry → exit |
|---|---|---|
| 00 · The room — read me, map, anatomy | [`1118:1768`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1118-1768) | Three tabs; links to Shell for first run, sign-in and You |
| 01 · First open — Coach-led setup | [`1081:565`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-565) | Empty Gym → Coach greeting → screenshot or talk → drafts applied or rejected on their card → Start (03); Build my own → 02 |
| 02 · Routines | [`1113:1474`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1113-1474) | Routines tab → Start (03) |
| 03 · Workout | [`1114:1513`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1114-1513) | Start / control → rack → wheel or Fix set → receipt → workout detail (05) or Coach (08) |
| 04 · Outside the app | [`1115:1576`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1115-1576) | Control Center, Live Activity, Dynamic Island → workout (03) |
| 05 · The log, past workouts & progress | [`1116:1605`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1605) | The log tab → workout detail, share, movement record |
| 06 · Bodyweight | [`1116:1683`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1683) | The log’s Weigh in → weigh-in sheet (decimal pad); Bodyweight → correct or swipe-delete |
| 07 · On this phone | [`1116:1705`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1705) | The log → inspect → fix or discard |
| 08 · Coach | [`1117:1703`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1117-1703) | Coach tab → conversation → proposal applied or rejected on its card; every change type and situation (08.15–08.31) |
| 09 · Notes & Connected log | [`1117:1768`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1117-1768) | You → Notes / Connected log |
| 10 · Not built — designed only | [`1118:1810`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1118-1810) | Apple Health |

First run, sign-in and You: Shell file, page [iOS](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=1-5).

## Gym · Android

Figma: Gym file, page [Android](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=56-2).
Code: `apps/android/gym/src/main/kotlin/works/windmill/gym/`. Components: Gym file, Components page,
section `🧩 Android · Material 3`. Numbers match the iOS page where the flow matches; the page is the
target ([consistency.md](design/consistency.md) 11a–11o); build tasks: `androidgym_tasks/`.

| Flow | Section | Entry → exit |
|---|---|---|
| 00 · The room — read me, map, anatomy | [`1224:13091`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13091) | Three tabs under one top app bar; colour roles, transient band, native parts |
| 01 · First open — Coach-led setup | [`1224:13095`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13095) | Empty Gym → Coach greeting → screenshot or talk → drafts applied or rejected on their card → Start (03); Build my own → 02 |
| 02 · Routines | [`1224:13099`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13099) | Routines tab → summary → Start (03); FAB → editor → picker → targets |
| 03 · Workout | [`1224:13103`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13103) | Start or the tile → rack (steppers) → Fix set → Finish → receipt → workout detail (05) or Coach (08) |
| 04 · Outside the app | [`1224:13107`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13107) | Quick Settings tile, ongoing notification, Live Update chip, lock screen → workout (03) |
| 05 · The log, past workouts & progress | [`1224:13111`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13111) | Log tab → workout detail, share, Record → Edit exercise |
| 06 · Bodyweight | [`1224:13115`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13115) | Log’s Weigh in → weigh-in sheet (decimal keyboard); Bodyweight → correct or swipe-delete |
| 07 · On this phone | [`1224:13119`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13119) | Sign in with training on the phone → Add or Discard; Saved workouts need review → inspect, keep or fix |
| 08 · Coach | [`1224:13123`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13123) | Coach tab → conversation → proposal applied or rejected on its card; every change type and situation (08.15–08.31) |
| 09 · Notes, Connected log & Gym settings | [`1224:13127`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1224-13127) | You → Gym settings / Connected log; Coach ⋮ → Notes |

Sign in, email code and You: Shell file, page [Android](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=1-6), section `33:1568`.
