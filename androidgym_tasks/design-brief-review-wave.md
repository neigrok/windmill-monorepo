# Design brief: Android review wave

For the owner and the designer. On 2026-11-02 an external code review of the Android app raised seven items that change what people see (D1–D7). The owner ruled on them on 2026-11-03 and approved every Android board; 02.27, 05.21 and 05.24 are built and 🚀 In production, the rest ✅ Ready for dev. The iOS mirror is 🚧 and waits for the owner. This brief records the rulings, the boards, how the built ones compare with their boards, and what is still open. Each board's caption holds its handoff: states, copy, tokens and what TalkBack reads. Ledger entry 11z in `docs/design/consistency.md` records where the code stands against these boards.

Files: Gym `vdmdiKWrmZoS1FtcvJRf6O`, Android page `56:2`; Shell `tkI7GnS6TcZvQSDi9lwrBf`, Android page `1:6`. Numbers follow ledger 11r. Every board has a Dark and a Daylight version.

## Owner rulings, 2026-11-03

- **Row labels lose "set".** A row is labelled by its number alone: *Set 1* reads *1*. Counts (*5 sets*), the routine editor's *Sets* field and *Vary by set* keep the word. Ledger 11z lists the boards that now follow this.
- **A workout says nothing about sync.** A set the workout saved is expected to sync. Sync problems live in one static place the lifter can open at any time: the You row and the screen it opens.
- **Rulings of the second round** (2026-11-03, as recommended):
  - the Fix set subtitle reads *Bench Press · 1*; the notification keeps *set 3 of 3*;
  - Coach links draw in the primary colour; an answer with several links offers Copy answer only; the menu flips above the bubble;
  - the copied state is a check icon with no word, spoken *Link copied* (05.25);
  - every screen no board draws uses the bounded column at large widths; rows are number-only at every width; the rail grows at 200 % text; 03.52 follows its caption and the rack stays as today;
  - package 120's twelve states and copy, as listed below.
- **Routine names are not sensitive.** The public lock-screen notification may show the routine name, and the Quick Settings tile is unchanged. D2 needs no board.

## Boards (approved 2026-11-03)

| Item | Board | What it settles | Dark · Daylight |
|---|---|---|---|
| D1 | Shell 16f · You — changes not synced yet | The You sheet's row is the one place that says work has not reached the account: count, cause and, when there is one, the action | [`263:3030`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=263-3030) · [`263:3118`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=263-3118) |
| D1 | Shell 16g · Not synced yet | The screen the row opens: where the work is and what happens next; *Waiting* (each record still held, with title, kind and time); *Didn't reach the log* (each refusal with the log's reason and Dismiss). No Retry, because the engine retries | [`266:2944`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=266-2944) · [`266:3080`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=266-3080) |
| D1 | Shell 16h · Not synced yet — sign in to sync | Session paused: the cause leads, and Sign in is pinned in the reach band. Update required reads *Update to sync*, with Update | [`266:3208`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=266-3208) · [`266:3332`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=266-3332) |
| D1 | 05.22 · The log — older workouts didn't load | A failed read is said where the content is missing: *Older workouts didn't load.* · Try again, replacing **Retry** · *That read failed.* No sync mark on rows | [`1847:29581`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29581) · [`1847:29659`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29659) |
| D3 | 08.66 · Coach — a link in an answer | Links draw in the primary colour, underlined; only http(s) become links; a tap opens a Custom Tab; TalkBack hears a link | [`1849:29958`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-29958) · [`1849:29975`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-29975) |
| D3 | 08.67 · Coach — long-press offers Copy link | For one link, Copy link copies the URL only; several links offer Copy answer only; the menu flips above the bubble | [`1849:29992`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-29992) · [`1849:30104`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-30104) |
| D4 | 05.21 · Workout detail — faint ink passes 4.5:1 | Dark faint ink is `#898E88` (5.16:1 on the card); the row number stays the quietest text; Daylight is unchanged | [`1847:29462`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29462) · [`1847:29519`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29519) |
| D5 | 00.9 · Tablets and unfolded phones (600 dp and wider) | The bottom tabs become a rail on the left; lists keep a readable 560 dp width | [`1851:30292`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-30292) · [`1851:30399`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-30399) |
| D5 | 00.10 · Tablet in landscape (840 dp and wider) | The same rail; the log stays one centred 640 dp column; Weigh in stays in the bottom-right corner | [`1851:30506`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-30506) · [`1851:30623`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-30623) |
| D5 | 02.27 · Movement editor at ≥ 600 dp | Every modal sheet is bounded to 560 dp and centred, with its phone layout inside | [`1851:31939`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-31939) · [`1851:32056`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-32056) |
| D5 | 03.52 · Logger at ≥ 840 dp | Reading pane left, rack pane right, anchored to the bottom; rows lead with their number; nothing about sync | [`1851:30960`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-30960) · [`1851:31032`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-31032) |
| D5 | 03.53 · Logger at compact height, keyboard up | The rack becomes one band above the keyboard: Load · Reps and Log set; the movement name moves into the title; no extract UI | [`1851:31104`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-31104) · [`1851:31299`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-31299) |
| D6 | 05.23 · Share — Share beside Copy link | Copy link (tonal, left) and Share (filled, right) at equal width; Revoke stays below | [`1850:30064`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30064) · [`1850:30158`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30158) |
| D6 | 05.24 · Share — the Android chooser | `ACTION_SEND` with the link alone; the chooser is the system's and heads itself *Sharing link* | [`1850:30252`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30252) · [`1850:30330`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30330) |
| D6 | 05.25 · Share — link copied | The tonal button shows a check icon and no word; TalkBack hears *Link copied* | [`1871:30162`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1871-30162) · [`1871:30256`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1871-30256) |
| D7 | 02.26 · Movement editor — Target stacks at 320 dp · 200 % | One line only when label + 8 dp + summary fit; otherwise both stack, start-aligned, 8 dp apart, and the summary wraps whole. The caption gives roles and sizes | [`1850:30891`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30891) · [`1850:30988`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30988) |

00.9 and 00.10 each carry a plain-language header on the canvas above them saying what the board is and why it exists. On ship, 05.23 supersedes 05.13b's single Copy link.

## Built boards against their boards

Compared on 2026-11-03 from the task files and the emulator evidence of tasks 115–117.

- **05.21 (task 115): match.** Row numbers read *1, 2, 3* and *Plan saved at start* stays the quietest text. The task records `#898E88` from a pixel sample; that sample was not repeated here. The Gym file still resolves the board to `#727771` until it accepts the published library update.
- **02.27 (task 115): match.** At 864 dp the Fix set sheet is 560 dp wide and centred; at 411 dp it is full width.
- **08.66 (task 116): match** after the owner's ruling: the link draws in the primary role, underlined, and opens a Custom Tab. TalkBack reading was not verified.
- **08.67 (task 116): one mismatch.** The single-link menu and the several-links Copy answer only match. The menu opens below the bubble over the composer, where the board flips it above.
- **05.23 (task 117): match in the action row.** Copy link (tonal, left) and Share (filled, right), equal width, Revoke below; Copy link turns into *Copied*, which breaks mid-word at 320 dp and 200 %; the owner ruled a check icon with no word (05.25), so the build follows. Outside the row the sheet keeps 05.13b's build values (ledger 11z).
- **05.24 (task 117): match.** The chooser sends the link alone. The system heads it *Sharing link* and ignores the app's title; board and caption now say so. The caption's events now follow the binding schema: `session/share_link` with `ok`, `unavailable` or `failed`, and failures reported as `gym.shareLink`.

## Package 120: states the approved boards leave open

Package 120 builds sync behind the You row (16f, 16g, 16h, 05.22). Its plan found states and copy those boards do not settle. They are drawn here and approved 2026-11-03 (✅), with the twelve answers below as the owner ruled them.

| Board | What it settles | Dark · Daylight |
|---|---|---|
| Gym 00.11 · Root screens — the seat's sync dot | 6 dp `color/brand` dot at the seat's top end, 1 dp inside the circle; one colour for every cause; ×4 spec beside the board | [`1867:30046`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1867-30046) · [`1867:30154`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1867-30154) |
| Shell 16i · You — sign in to sync | Login glyph; *Sign in to sync* / *Saved on this phone. Sign in again and they sync.*; chevron | [`268:2985`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-2985) · [`268:3079`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3079) |
| Shell 16j · You — update to sync | System-update glyph; *Update to sync* / *Saved on this phone. Get the update and they sync.* | [`268:3173`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3173) · [`268:3267`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3267) |
| Shell 16k · You — a change didn't reach the log | Error-outline glyph in ink; *1 change didn't reach the log* / *Open to see the log's reason.* | [`268:3361`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3361) · [`268:3455`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3455) |
| Shell 16l · Not synced yet — refused only | *1 change didn't reach the log* / *Everything else is on your account.*; no Waiting section | [`268:3549`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3549) · [`268:3589`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3589) |
| Shell 16m · Not synced yet — everything is on your account | Check glyph and *Everything is on your account.* in the status title style; nothing else | [`268:3629`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3629) · [`268:3669`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3669) |
| Shell 16n · Update to sync — the link didn't open | *Get the update* button; *The link didn't open. Try again, or visit windmill.works.* above it, secondary ink | [`268:3709`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3709) · [`268:3747`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=268-3747) |

The owner's rulings (each as recommended):

1. **Seat dot.** a 6 dp `color/brand` dot at the top end (00.11), one colour for every cause, never error red.
2. **The 16f row's second line.** *Saved on this phone. Sign in again and they sync.* · *Saved on this phone. Get the update and they sync.* · *Open to see the log's reason.*
3. **Icons.** login for sign-in, system-update (the phone glyph with an arrow) for update, error-outline in ink for a refusal, on both the row (20 dp) and the status block (24 dp).
4. **16g's missing states.** 16l for refused-only and 16m (check glyph, status title, nothing else) for empty.
5. **The seat's TalkBack.** the label stays *Your account* and its state reads the 16f headline, for example *Sign in to sync*.
6. **The failed update link.** *The link didn't open. Try again, or visit windmill.works.* above the button, 13 sp secondary ink, polite live region, no red.
7. **The update button.** *Get the update*: it opens a download link, so it should not promise an in-app update. The 16j/16n headline stays *Update to sync*.
8. **Item copy.** title, then *Kind · when*:
   - *Routine · edited today*, *Movement · edited today*, *Settings · edited today*, *Weigh-in · deleted today*;
   - days: *Today*, *Yesterday*, then the date (*Thu 22 Oct*); a workout adds its time (*Workout · Yesterday, 19:10*);
   - refused titles: *Push A · Thu 22 Oct* (or *Workout · Thu 22 Oct*), and *Kind · name* for other changes (*Note · Knee*);
   - plurals follow the count: *1 change*, *2 changes*.
9. **Two numbers.** Aligned: the row counts what 16g lists, so one workout reads *1 change not synced yet* beside *Waiting · 1*. Sign-out's 16e keeps its own count.
10. **Refusals on Routines and Notes.** Yes, they move to 16g: one static place, and the seat dot points there.
11. **Update required with nothing waiting.** showing the row anyway (*Update to sync* / *Get the update to keep syncing.*) with the seat dot, since only the lifter can fix it.
12. **Honest waiting copy.** *They sync when you're online.* only while the phone is offline; otherwise *They sync as soon as the log answers.* This applies to the 16f row and the 16g status.

## iOS mirror (🚧, awaiting the owner)

The owner asked for the wave on iOS too ("we need to replicate it to the ios designs and make tasks for it to be implemented in the future"). Tasks: `iosgym_tasks/review-wave.md` (rw-01–rw-07). The app targets iPhone only (`apps/ios/App/project.yml` `TARGETED_DEVICE_FAMILY: "1"`), so the large-screen boards have no iOS twin; iOS draws targets as form rows, so 02.26 has none either. No iOS board redacts the routine name on the lock screen.

| Board | What it settles | Dark · Daylight |
|---|---|---|
| Shell iOS 16f · You — changes not synced yet | The identity card's status speaks the 16f words and opens Not synced yet | [`278:5588`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5588) · [`278:5661`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5661) |
| Shell iOS 16i · sign in to sync | Status *Sign in to sync* | [`278:5734`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5734) · [`278:5807`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5807) |
| Shell iOS 16j · update to sync | Status *Update to sync*; Get the update row stays | [`278:5880`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5880) · [`278:5953`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5953) |
| Shell iOS 16k · a change didn't reach the log | Status *1 change didn't reach the log* | [`278:6026`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6026) · [`278:6099`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6099) |
| Shell iOS 16g · Not synced yet | Pushed in You: status card, WAITING · N, DIDN'T REACH THE LOG with Dismiss | [`278:6172`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6172) · [`278:6280`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6280) |
| Shell iOS 16h · sign in to sync | The cause leads; Sign in pinned | [`278:6388`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6388) · [`278:6490`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6490) |
| Shell iOS 16l · refused only | *Everything else is on your account.* | [`278:6592`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6592) · [`278:6681`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6681) |
| Shell iOS 16m · everything is on your account | The one line and a checkmark | [`278:6770`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6770) · [`278:6850`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6850) |
| Shell iOS 16n · update, the link didn't open | Get the update pinned; the failed-link line above it | [`278:6930`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6930) · [`278:7033`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-7033) |
| Gym iOS 00.11 · the account button's sync dot | 8 pt `gym/accent` dot, top trailing | [`1875:15844`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-15844) · [`1875:15923`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-15923) |
| Gym iOS 03.24b · reps sheet | Title the movement, subtitle *3 of 3* | [`1875:16007`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16007) · [`1875:16080`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16080) |
| Gym iOS 03.25b · Fix set | Title the movement, subtitle *2 of 3* | [`1875:16153`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16153) · [`1875:16242`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16242) |
| Gym iOS 05.23 · the link is live | Copy link (.bordered) and Share (prominent), Revoke below | [`1876:16484`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16484) · [`1876:16517`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16517) |
| Gym iOS 05.24 · the iOS share sheet | `ShareLink` with the link alone | [`1876:16550`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16550) · [`1876:16594`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16594) |
| Gym iOS 05.25 · link copied | Checkmark, no word | [`1876:16638`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16638) · [`1876:16669`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16669) |
| Gym iOS 08.66 · a link in an answer | `gym/accent`, underlined, SFSafariViewController | [`1875:16341`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16341) · [`1875:16382`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16382) |
| Gym iOS 08.67 · context menu offers Copy link | Copy answer and, for one link, Copy link | [`1875:16423`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16423) · [`1875:16515`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16515) |

The library's `dark/ios/gym/ink-faint` is raised to `#898E88` (rw-04); it reaches the iOS boards once the library is published and accepted.

iOS questions for the owner, each with the designer's recommendation:

1. **Where sync lives on iOS.** *Recommend* the identity card under You, which already carries the account's status, rather than a separate row: it opens Not synced yet when anything waits.
2. **The status words.** *Recommend* the Android words (*2 changes not synced yet*, *Sign in to sync*, *Update to sync*, *1 change didn't reach the log*) in place of *Not backed up yet* and *Syncing paused · …*; *Backed up* stays when everything has synced.
3. **The update alert.** *Recommend* it never opens during a workout (decided) and, outside one, gives way to the status line and the dot, as on Android.
4. **Sheet titles without "Set".** *Recommend* the movement as the title and the row's place as the subtitle (*Dumbbell Bench Press* / *3 of 3*): a one-line *Dumbbell Bench Press · 3* collides with Cancel and Done.
5. **Faint ink.** *Recommend* Dark `gym/ink-faint` `#898E88`, as Android ships, so planned rows and Edit sets numbers pass 4.5:1.
6. **Links.** *Recommend* `gym/accent` with an underline (iOS draws links without one by default), so colour is never the only mark.
7. **Dot.** *Recommend* 8 pt on the 44 pt account button.

## Parity

- **iOS** marks unsent sets in the workout ledger with a phone glyph (`Gym/Workout/WorkoutScreen.swift`, `WorkoutLedgerRow` `unsent`) and unsent workouts on the log row (`Gym/Log/LogTab.swift:248`). Under the sync ruling the workout ledger mark goes; iOS needs the You row and the 16g screen, and its Update required alert (`WindmillApp.swift:158`) must not open during a workout. iOS `dark/ios/gym/ink-faint` is still `#727771`.
- **Web** has no live logger. It needs the same row in the account menu, the seat dot and the 16g list, in the same words. `web/src/products/gym/gymTokens.css` states that the web never holds a set only on the device; engineering should confirm that before a web board is drawn. Web gym-night `--neutral-500` is still `#727771`.
