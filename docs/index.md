# Flow index

Where each user flow is drawn. Each section reads left to right; every board's caption names the code
that ships it and its check against the simulator (2026-10-21, `cd7bdbe5`; ledger 10o). Captures fill
slots that have no drawing. Only Gym on iOS is indexed here so far.

## Gym · iOS

Figma: Gym file, page [iOS](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-2).
Code: `apps/ios/App/Sources/Gym/`. Spec: [ios-redesign.md](design/ios/ios-redesign.md).

| Flow | Section | Entry → exit | Verified · differs · not verified · captures |
|---|---|---|---|
| 00 · The room — read me, map, anatomy | [`1118:1768`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1118-1768) | Three tabs; links to Shell for first run, sign-in and You | 0 · 3 · 1 · 0 |
| 01 · First open — Coach-led setup | [`1081:565`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-565) | Empty Gym → Coach setup → routines → Start (03); Just log → 03; Build it myself → 02 | 1 · 4 · 9 · 0 |
| 02 · Routines | [`1113:1474`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1113-1474) | Routines tab → Start (03) | 0 · 6 · 0 · 1 |
| 03 · Workout | [`1114:1513`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1114-1513) | Start / Just log / control → receipt → workout detail (05) or Coach (08) | 0 · 5 · 1 · 3 |
| 04 · Outside the app | [`1115:1576`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1115-1576) | Control Center, Live Activity, Dynamic Island → workout (03) | 0 · 0 · 5 · 0 |
| 05 · The log, past workouts & progress | [`1116:1605`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1605) | The log tab → workout detail, share, movement record | 0 · 4 · 3 · 2 |
| 06 · Bodyweight | [`1116:1683`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1683) | Weigh in → Bodyweight | 0 · 1 · 0 · 1 |
| 07 · On this phone | [`1116:1705`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1116-1705) | The log → inspect → fix or discard | 0 · 0 · 0 · 3 |
| 08 · Coach | [`1117:1703`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1117-1703) | Coach tab → conversation → proposal review | 0 · 3 · 3 · 2 |
| 09 · Notes & Connected log | [`1117:1768`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1117-1768) | You → Notes / Connected log | 0 · 2 · 0 · 1 |
| 10 · Not built — designed only | [`1118:1810`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1118-1810) | Apple Health | 0 · 0 · 1 · 0 |

First run, sign-in and You: Shell file, page [iOS](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=1-5).
