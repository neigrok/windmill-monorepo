# Design brief: Android review wave

For the owner and the designer. On 2026-11-02 an external code review of the Android app raised seven items that change what people see (D1–D7). The owner ruled on them on 2026-11-03 and approved every board in the wave; 02.27, 05.21, 05.23 and 05.24 are built and 🚀 In production, the rest ✅ Ready for dev. This brief records the rulings, the boards, how the built ones compare with their boards, and what is still open. Each board's caption holds its handoff: states, copy, tokens and what TalkBack reads. Ledger entry 11z in `docs/design/consistency.md` records where the code stands against these boards.

Files: Gym `vdmdiKWrmZoS1FtcvJRf6O`, Android page `56:2`; Shell `tkI7GnS6TcZvQSDi9lwrBf`, Android page `1:6`. Numbers follow ledger 11r. Every board has a Dark and a Daylight version.

## Owner rulings, 2026-11-03

- **Row labels lose "set".** A row is labelled by its number alone: *Set 1* reads *1*. Counts (*5 sets*), the routine editor's *Sets* field and *Vary by set* keep the word. Ledger 11z lists the boards that now follow this.
- **A workout says nothing about sync.** A set the workout saved is expected to sync. Sync problems live in one static place the lifter can open at any time: the You row and the screen it opens.
- **Routine names are not sensitive.** The public lock-screen notification may show the routine name, and the Quick Settings tile is unchanged. D2 needs no board.

## Boards (approved 2026-11-03)

| Item | Board | What it settles | Dark · Daylight |
|---|---|---|---|
| D1 | Shell 16f · You — changes not synced yet | The You sheet's row is the one place that says work has not reached the account: count, cause and, when there is one, the action | [`263:3030`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=263-3030) · [`263:3118`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=263-3118) |
| D1 | Shell 16g · Not synced yet | The screen the row opens: where the work is and what happens next; *Waiting* (each record still held, with title, kind and time); *Didn't reach the log* (each refusal with the log's reason and Dismiss). No Retry, because the engine retries | [`266:2944`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=266-2944) · [`266:3080`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=266-3080) |
| D1 | Shell 16h · Not synced yet — sign in to sync | Session paused: the cause leads, and Sign in is pinned in the reach band. Update required reads *Update to sync*, with Update | [`266:3208`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=266-3208) · [`266:3332`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=266-3332) |
| D1 | 05.22 · The log — older workouts didn't load | A failed read is said where the content is missing: *Older workouts didn't load.* · Try again, replacing **Retry** · *That read failed.* No sync mark on rows | [`1847:29581`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29581) · [`1847:29659`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29659) |
| D3 | 08.66 · Coach — a link in an answer | Links are underlined; only http(s) become links; a tap opens a Custom Tab; TalkBack hears a link | [`1849:29958`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-29958) · [`1849:29975`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-29975) |
| D3 | 08.67 · Coach — long-press offers Copy link | Copy link copies the URL only; Copy answer writes *text (url)* | [`1849:29992`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-29992) · [`1849:30104`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1849-30104) |
| D4 | 05.21 · Workout detail — faint ink passes 4.5:1 | Dark faint ink is `#898E88` (5.16:1 on the card); the row number stays the quietest text; Daylight is unchanged | [`1847:29462`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29462) · [`1847:29519`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1847-29519) |
| D5 | 00.9 · Tablets and unfolded phones (600 dp and wider) | The bottom tabs become a rail on the left; lists keep a readable 560 dp width | [`1851:30292`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-30292) · [`1851:30399`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-30399) |
| D5 | 00.10 · Tablet in landscape (840 dp and wider) | The same rail; the log stays one centred 640 dp column; Weigh in stays in the bottom-right corner | [`1851:30506`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-30506) · [`1851:30623`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-30623) |
| D5 | 02.27 · Movement editor at ≥ 600 dp | Every modal sheet is bounded to 560 dp and centred, with its phone layout inside | [`1851:31939`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-31939) · [`1851:32056`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-32056) |
| D5 | 03.52 · Logger at ≥ 840 dp | Reading pane left, rack pane right, anchored to the bottom; rows lead with their number; nothing about sync | [`1851:30960`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-30960) · [`1851:31032`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-31032) |
| D5 | 03.53 · Logger at compact height, keyboard up | The rack becomes one band above the keyboard: Load · Reps and Log set; the movement name moves into the title; no extract UI | [`1851:31104`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-31104) · [`1851:31299`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1851-31299) |
| D6 | 05.23 · Share — Share beside Copy link | Copy link (tonal, left) and Share (filled, right) at equal width; Revoke stays below | [`1850:30064`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30064) · [`1850:30158`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30158) |
| D6 | 05.24 · Share — the Android chooser | `ACTION_SEND` with the link alone; the chooser is the system's and heads itself *Sharing link* | [`1850:30252`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30252) · [`1850:30330`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30330) |
| D7 | 02.26 · Movement editor — Target stacks at 320 dp · 200 % | One line only when label + 8 dp + summary fit; otherwise both stack, start-aligned, 8 dp apart, and the summary wraps whole. The caption gives roles and sizes | [`1850:30891`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30891) · [`1850:30988`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30988) |

00.9 and 00.10 each carry a plain-language header on the canvas above them saying what the board is and why it exists. On ship, 05.23 supersedes 05.13b's single Copy link.

## Built boards against their boards

Compared on 2026-11-03 from the task files and the emulator evidence of tasks 115–117.

- **05.21 (task 115): match.** Row numbers read *1, 2, 3* and *Plan saved at start* stays the quietest text. The task records `#898E88` from a pixel sample; that sample was not repeated here. The Gym file still resolves the board to `#727771` until it accepts the published library update.
- **02.27 (task 115): match.** At 864 dp the Fix set sheet is 560 dp wide and centred; at 411 dp it is full width.
- **08.66 (task 116): mismatch in one token.** The link is underlined and opens a Custom Tab, as drawn. Its ink is the primary role (Daylight `#137A6C`) where the board draws `text/link` (`#106B5F`); Dark is `#5FCDB4` either way. TalkBack reading was not verified.
- **08.67 (task 116): two mismatches.** For one link, the menu offers Copy answer and Copy link, and the copies match the caption. An answer with several links offers Copy answer only, where the caption offers one Copy link per link, up to three. The menu opens below the bubble over the composer, where the board flips it above.
- **05.23 (task 117): match in the action row.** Copy link (tonal, left) and Share (filled, right), equal width, Revoke below; Copy link turns into *Copied*. At 320 dp and 200 % *Copied* breaks mid-word (*Copie / d*). Outside the row the sheet keeps 05.13b's build values (ledger 11z).
- **05.24 (task 117): match.** The chooser sends the link alone. The system heads it *Sharing link* and ignores the app's title; board and caption now say so. The caption's events now follow the binding schema: `session/share_link` with `ok`, `unavailable` or `failed`, and failures reported as `gym.shareLink`.

## Questions for the owner

Each question has the designer's recommendation.

1. **Fix set subtitle.** Is *Bench Press · Set 1* (Android 03.3, 03.33; iOS 03.24, 03.25) a row label under the ruling? *Recommend* *Bench Press · 1*, since it names the row the lifter tapped.
2. **Notification counter.** Does *set 3 of 3* (04.1–04.3) keep the word? *Recommend keep.* It is a count, not a row label.
3. **08.66 link ink.** Should the board follow the build's primary role, or the build follow `text/link`? *Recommend the primary role.* Android has no separate link role; Daylight `#137A6C` reads 4.84:1 on the bubble `#F8F6F4`.
4. **08.67 several links.** Copy answer only (as built) or one Copy link per link (as drawn)? *Recommend as built* until answers with several links are common: it keeps the menu short.
5. **08.67 menu position.** Should the menu flip above the bubble when it would cover the composer, as drawn? *Recommend yes.*
6. **05.23 *Copied* at 200 %.** *Recommend a check icon with no word* in the tonal button for the copied state, with *Link copied* kept as the spoken announcement.

## Parity

- **iOS** marks unsent sets in the workout ledger with a phone glyph (`Gym/Workout/WorkoutScreen.swift`, `WorkoutLedgerRow` `unsent`) and unsent workouts on the log row (`Gym/Log/LogTab.swift:248`). Under the sync ruling the workout ledger mark goes; iOS needs the You row and the 16g screen, and its Update required alert (`WindmillApp.swift:158`) must not open during a workout. iOS `dark/ios/gym/ink-faint` is still `#727771`.
- **Web** has no live logger. It needs the same row in the account menu, the seat dot and the 16g list, in the same words. `web/src/products/gym/gymTokens.css` states that the web never holds a set only on the device; engineering should confirm that before a web board is drawn. Web gym-night `--neutral-500` is still `#727771`.
