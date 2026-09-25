# Gym web build contract

Audit of [Web · Gym](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=466-132), 26 September 2026. The page contains 102 implementation boards in 51 desktop/narrow pairs: Plan 20, Record 42, Coach 14, Share 26. **62 boards are Ready; 40 remain Built.** Content proportions are implemented. Ready statuses remain while the protected navigation differences in F59 prevent complete screen acceptance. Start and Components are reference sections, not implementation boards.

The acceptance gate is the [implementation plan](web-implementation-plan.md): running local web with live fixture data, at 1440 and 390, checked against each board. A code change or a passing unit test alone does not qualify a board as Built. The status-node column identifies the instance to update after that evidence exists.

## Shared frame and measurements

All authenticated boards inherit W1. The shared app header is 52px high, with a 30px Windmill mark, centered Home/Roadmap/Journal/Gym links and a 30px account avatar. Side insets are 16px desktop and 12px at widths up to 480px. Routines, The log and Coach sit in a 64px bottom panel with a subtle top border; their group is centered horizontally, with 32px gaps and 50px touch targets. Active controls use brand ink, inactive controls faint ink. Pushed pages retain the bottom navigation. The runtime header consumes the top safe-area inset; the bottom panel consumes the bottom safe-area inset. Content scrolls in the space between them.

Content begins at y84 on both desktop and narrow screens. Narrow content x16/w358. Desktop
focused content is centered at x400/w640; figures keep a 420px intrinsic measure. The Log,
Coach, Notes and populated past-workout forms retain their centered 1024px workspaces at x208.
The routine editor is centered at x314/w812: 360px movements +32px gap +420px targets. A back link
remains a 44px row before the title and follows its content container. Shared header and
bottom-navigation geometry are unchanged.
These measurements describe the content contract. The current runtime comparisons and release gate are recorded in [web-verification.md](web-verification.md).

| Surface | Figma layout |
|---|---|
| Log selected 1440, `470:34` | Content x208/y84/w1024; index320 +24 gap +reader680; navigation44 high, reader with 12px gaps. |
| Log default 390, `470:21` | Content x16/y84/w358, gap16; progress before history. Progress cards gap24. History index is scrollable. Weigh in and Add past workout sit beside each other, 54px high in the 86px footer above navigation. |
| Routine editor 1440, `475:1050` | Content x314/w812; split 360/32/420; 44px ladder rows with 4px gaps; 197×44px action group with 24px gap. |
| Routine conflict 1440, `475:1238` | Content x284/w872; two 420px comparison columns with 32px gap. |
| Edit workout 1440, `482:1175` | Content x284/y84/w872, 32px section gaps; 420px form +32px gap +420px saved summary; grouped actions at content foot. |
| Fix set 1440, `482:1224` | Standalone numeric form x510/w420; grouped local actions. |
| Coach 1440, `471:522` | Conversation x208/y84/w640; side rail x880/y84/w352; 16px region gap and 24px rail gap; Apply 81×44. Chat remains bottom-anchored. |
| Notes 1440, `472:215` | Main x208/w640 +32 gap +352px Rooms/connected-tools rail at x880. |
| Share setup 1440, `508:1353` | Content x400/y84/w640; sections gap24; scope and update choices precede privacy panel and Preview. |
| Recipient log 1440, `524:2705` | Public header x208/y36/h24; snapshot line y82; content x208/y132/w1024. No authenticated shell or write controls. |

Set rows use a 10px rail with 2px ticks. Load × reps uses JetBrains Mono; the multiplication sign is faint. Equal sets collapse to a scheme; variable sets remain rows. Units appear once in a column head or total. Add set is last. Row actions reveal on hover/focus, not layout shift. History rows are 56px with 4px between rows and year groups.

The Log header uses a 20px share icon in a 44px target with accessible name and tooltip
`Share log`. Desktop places Weigh in beside Add past workout in that header; narrow screens
place the pair in the footer. Log options retain the latest bodyweight reading and density control.

## Type and colour

The fourteen current `Gym/Web/*` styles:

| Style | Family / weight | Size / line |
|---|---|---|
| Title | Baloo 2 /700 | 32/40 |
| Title Narrow | Baloo 2 /700 | 28/36 |
| Section | Nunito /700 | 17/24 |
| Row | Nunito /600 | 15/22 |
| Prose | Nunito /400 | 16/24 |
| Body | Nunito /400 | 14/21 |
| Label | Nunito /700 | 14/20 |
| Meta | Nunito /400 | 13/18 |
| Meta Strong | Nunito /700 | 13/18 |
| Caption | Nunito /400 | 12/16 |
| Kicker | Nunito /600 | 12/16 |
| Figure | JetBrains Mono /400 | 16/20 |
| Figure Small | JetBrains Mono /400 | 13/18 |
| Stat | JetBrains Mono /500 | 28/32 |

The narrow conflict comparison uses the 32/40 Title style.

Use existing token aliases, not these verification hex values as new literals. Instrument: canvas #0b1111, surface #161c1d, line #202627, strong line #2a3133, ink #f1f0eb, dim #b6b5af, faint #727771, brand #5fcdb4, accent ink #1b1408, PR #d9b04c. Daylight: canvas #ebe7e3, surface #f8f6f4, ink #1a1918, dim #4c4744, faint #625c58, brand #4c4374, accent ink white. Colour is bound to Gym · Colour; spaces/radii/measures to Gym · Metrics.

Card radius 16 is the general rule. Existing progress cards, editable rows and local action-band buttons bind radius/md 12. Spacing follows 4px increments: 32px between sections, 24px within sections and 8/12/16px between related elements. Do not flatten all component radii to one value.

Daylight PR ink uses the approved gold-700 `#6E5217`, with the existing 14% gold-600 PR tint. The
plain/tinted contrast pairs are canvas 5.92/5.13, card 6.76/5.79 and raised 5.25/4.60. Figma token
`VariableID:872:7735` and specimen `874:7735` are the source; native lag is tracked in F4.

Feedback follows web-form.md: row hover 150ms, underline 180ms, number change 280ms, add 280ms, remove 180ms, saved readout 900ms, proposal transition 280ms. Reduced motion preserves colour changes and removes movement.

## High-fidelity context references

Screenshots and full design contexts were retrieved for `470:34`, `470:21`, `475:1050`, `482:1175`, `470:8`, `470:60`, `471:522`, `472:251`, `508:1353`, `524:2705`, and `476:1082`. These cover the shell, both log compositions, editor, correction, movement record, Coach, note editor, sharing setup, recipient and Daylight. Generated code is a visual reference; adapt it to the existing React components and token CSS. Small arrow/door assets are static and must use the exact supplied asset or an exact existing match; charts represent dynamic session data.

## Implementation decisions

- Two boards explicitly depict Daylight Routines (`476:1082` and `476:1115`). Every other board is exported and compared using both Instrument and Daylight mode tokens. The shared shadow and warning bindings added for content parity are local to the Gym file and are not published.
- The implementation uses current mode tokens in both themes. Temporary Figma mode overrides are restored after exporting the references.
- The Routines open menus in Instrument and Daylight contain Log past followed by Delete.
- Literal catalog spelling is current data: the editor/default fixture says Chin Up while some record fixtures say Chin-up. Do not rename backend records to imitate fixture typography.
- Native time inputs keep the user's system clock convention while editing. Backfill shows its selected value in a 24-hour resting label and the stored-hour disclosure.
- Shared shell components `468:2` and `468:13` retain the shared app header and place Gym navigation at the bottom. Their descriptions and Gym Tab `4:7` describe the current placement and content y84. The board status column distinguishes approved drawings from verified implementation.
- The two Saved backfill boards reuse the current selected-reader composition (`470:34` and `470:47`) with the saved Undo receipt. Saving opens that reader; the form does not introduce a second workout presentation.
- The narrow New routine drawing includes the same required name input as desktop, with the missing-name reason beside Save. The input reuses the compact library component.
- Correction specimens use the current totals copy without set-kind terminology; both pending action specimens read Saving.
- All eight Coach conversation boards follow the current [feedback contract](feedback-contract.md): History and More in the heading, Add photo in the composer, and contextual limits. The composed boards reuse the quiet navigation control and system-bound Lucide icons. Runtime conversations retain their history, and deletion belongs in More. Content-sized desktop Apply and local spacing belong to the Ready visual gate.

## Content and theme verification

All 102 implementation boards have fresh 1× references and state-specific runtime captures.
The matrix compares 202 primary renders: both themes for 100 boards and Daylight for the two
explicit Daylight boards. Independent visual review distinguishes fixture data, focus and native
editing states from layout defects. Header, navigation, back-link and board-dimension fingerprints
remain protected during reference corrections.

The content pass uses the centered measures, grouped actions and consistent field, row and chart
recipes above. Existing capabilities remain available. Complete screen acceptance is separate:
F59 records the protected navigation differences, so this pass does not promote Ready to Built.
[web-verification.md](web-verification.md) records the current build, checks and deployment.

## Board acceptance map

W1 applies to every authenticated board. The principal wave counts are W2 24, W3 18, W4 6, W5 14, W6 12, W7 26, W8 2. Each status cell records the current Figma status.

| Board | Node | Status / node | Wave | Acceptance |
|---|---|---|---|---|
| Coach / Conversation / Applied / 1440 | `473:285` | **Built** · `804:5945` | W5 | Proposal message becomes applied receipt; changed targets visible. |
| Coach / Conversation / Applied / 390 | `473:350` | **Built** · `804:5948` | W5 | Proposal message becomes applied receipt; changed targets visible. |
| Coach / Conversation / Proposal / 1440 | `471:522` | **Ready** · `804:5933` | W5 | Inline diff; Push A · 1 change; Apply then Turn this down; composer fits. |
| Coach / Conversation / Proposal / 390 | `471:537` | **Built** · `804:5936` | W5 | Inline diff; Push A · 1 change; Apply then Turn this down; composer fits. |
| Coach / Conversation / Turned down / 1440 | `493:1404` | **Built** · `804:5939` | W5 | Proposal message becomes declined receipt in place. |
| Coach / Conversation / Turned down / 390 | `493:1488` | **Built** · `804:5942` | W5 | Proposal message becomes declined receipt in place. |
| Coach / Conversation / Workout in progress / 1440 | `473:331` | **Built** · `804:5951` | W5 | Live-session context; Coach proposes only; no web Start. |
| Coach / Conversation / Workout in progress / 390 | `473:393` | **Built** · `804:5954` | W5 | Live-session context; Coach proposes only; no web Start. |
| Coach / Note editor / Existing note / 1440 | `472:251` | **Ready** · `804:5963` | W5 | Edit note heading, disclosure, title/body limits, Save and Cancel. |
| Coach / Note editor / Existing note / 390 | `472:317` | **Ready** · `804:5966` | W5 | Edit note heading, disclosure, title/body limits, Save and Cancel. |
| Coach / Note editor / New note / 1440 | `482:1099` | **Ready** · `804:5969` | W5 | New note heading, disclosure, title/body limits, Save and Cancel. |
| Coach / Note editor / New note / 390 | `482:1136` | **Ready** · `804:5972` | W5 | New note heading, disclosure, title/body limits, Save and Cancel. |
| Coach / Notes / Default / 1440 | `472:215` | **Ready** · `804:5957` | W5 | Notes heading and connected-agent disclosure; note rows open editor. |
| Coach / Notes / Default / 390 | `472:281` | **Ready** · `804:5960` | W5 | Notes heading and connected-agent disclosure; note rows open editor. |
| Plan / New routine / Default / 1440 | `480:1556` | **Ready** · `804:5847` | W3 | Name draft; selected movement targets; Add movement; create only on Save. |
| Plan / New routine / Default / 390 | `862:7256` | **Ready** · `862:7313` | W3 | Name draft; selected movement targets; Add movement; create only on Save. |
| Plan / New routine / Picker / 1440 | `862:7370` | **Ready** · `862:7436` | W3 | Search and select movements in editor right pane. |
| Plan / New routine / Picker / 390 | `480:1504` | **Ready** · `804:5850` | W3 | Search and select movements in narrow sheet. |
| Plan / Routine editor / Conflict / 1440 | `475:1238` | **Ready** · `804:5853` | W3 | Keep draft; show latest routine; explicit conflict recovery. |
| Plan / Routine editor / Conflict / 390 | `862:7478` | **Ready** · `862:7543` | W3 | Keep draft; show latest routine; explicit conflict recovery. |
| Plan / Routine editor / Copy-down / 1440 | `485:1341` | **Ready** · `804:5841` | W3 | Every set applies 80 kg to all five Back Squat sets while preserving their reps. |
| Plan / Routine editor / Copy-down / 390 | `480:1614` | **Ready** · `804:5844` | W3 | Every set applies 80 kg to all five Back Squat sets while preserving their reps. |
| Plan / Routine editor / Default / 1440 | `475:1050` | **Ready** · `804:5826` | W3 | 360px movement list +32px gap +420px ladder pane; persistent draft. |
| Plan / Routine editor / Default / 390 | `475:1106` | **Ready** · `804:5829` | W3 | Movement list; selected targets open in sheet; persistent draft. |
| Plan / Routine editor / Ladder / 1440 | `485:1254` | **Ready** · `804:5835` | W3 | Variable per-set targets; Every set and Set by set both visible. |
| Plan / Routine editor / Ladder / 390 | `480:1387` | **Ready** · `804:5838` | W3 | Variable per-set targets; Every set and Set by set both visible. |
| Plan / Routine editor / Six sets / 1440 | `862:7051` | **Ready** · `862:7133` | W3 | Right pane contains six editable sets and Add set last. |
| Plan / Routine editor / Six sets / 390 | `475:1156` | **Ready** · `804:5832` | W3 | Sheet contains six editable sets and Add set last. |
| Plan / Routines / Daylight / 1440 | `476:1082` | **Ready** · `804:5856` | W8 | Daylight tokens; same routine list and interactions. |
| Plan / Routines / Daylight / 390 | `476:1115` | **Ready** · `804:5859` | W8 | Daylight tokens; same routine list and interactions. |
| Plan / Routines / Default / 1440 | `475:892` | **Ready** · `804:5814` | W3 | Your routines; card opens draft; movement names and grouped rail; New routine. |
| Plan / Routines / Default / 390 | `475:945` | **Ready** · `804:5817` | W3 | Your routines; card opens draft; movement names and grouped rail; New routine. |
| Plan / Routines / Empty / 1440 | `475:992` | **Ready** · `804:5820` | W3 | Empty plan invitation; New routine action. |
| Plan / Routines / Empty / 390 | `475:1024` | **Ready** · `804:5823` | W3 | Empty plan invitation; New routine action. |
| Record / Add past workout / Edited / 1440 | `834:7731` | **Built** · `834:7752` | W2 | Retain changed values and added/removed rows; one atomic Save. |
| Record / Add past workout / Edited / 390 | `834:7956` | **Built** · `834:7971` | W2 | Retain changed values and added/removed rows; one atomic Save. |
| Record / Add past workout / Free session / 1440 | `835:7226` | **Built** · `835:7247` | W2 | Blank session accepts movement rows without changing a routine. |
| Record / Add past workout / Free session / 390 | `835:7323` | **Built** · `835:7338` | W2 | Blank session accepts movement rows without changing a routine. |
| Record / Add past workout / From a routine / 1440 | `832:7458` | **Ready** · `832:7564` | W2 | Routine menu Log past enters prefilled session; plan is unchanged. |
| Record / Add past workout / From a routine / 390 | `835:15047` | **Ready** · `835:15146` | W2 | Routine menu Log past enters prefilled session; plan is unchanged. |
| Record / Add past workout / No routines / 1440 | `835:7387` | **Built** · `835:7408` | W2 | Empty routine choice; Free session remains usable. |
| Record / Add past workout / No routines / 390 | `835:7438` | **Built** · `835:7453` | W2 | Empty routine choice; Free session remains usable. |
| Record / Add past workout / Overlap refusal / 1440 | `835:6896` | **Built** · `835:6917` | W2 | Retain complete draft; explain overlap refusal; reopen offending control. |
| Record / Add past workout / Overlap refusal / 390 | `835:7075` | **Built** · `835:7090` | W2 | Retain complete draft; explain overlap refusal; reopen offending control. |
| Record / Add past workout / Pick routine / 1440 | `834:7279` | **Ready** · `834:7300` | W2 | Routine picker fills target/last-time values; Free session alternative. |
| Record / Add past workout / Pick routine / 390 | `834:7339` | **Built** · `834:7354` | W2 | Routine picker fills target/last-time values; Free session alternative. |
| Record / Add past workout / Prefilled / 1440 | `834:7393` | **Built** · `834:7414` | W2 | Editable prefilled targets; one-tap day; default hour disclosed beside Save. |
| Record / Add past workout / Prefilled / 390 | `834:7576` | **Built** · `834:7591` | W2 | Editable prefilled targets; one-tap day; default hour disclosed beside Save. |
| Record / Add past workout / Saved / 1440 | `835:7481` | **Ready** · `835:7502` | W2 | Return to log split with newly saved workout selected. |
| Record / Add past workout / Saved / 390 | `835:7623` | **Ready** · `835:7638` | W2 | Open saved workout detail with actual values. |
| Record / Add past workout / Time changed / 1440 | `835:6578` | **Built** · `835:6599` | W2 | Native hour input; Save disclosure reflects stored time. |
| Record / Add past workout / Time changed / 390 | `835:6751` | **Built** · `835:6766` | W2 | Native hour input; Save disclosure reflects stored time. |
| Record / Edit workout / Default / 1440 | `482:1175` | **Ready** · `804:5920` | W4 | Inline metadata and editable numbers; Save changes; no keypad sheet. |
| Record / Edit workout / Default / 390 | `862:7838` | **Ready** · `862:7882` | W4 | Inline metadata and editable numbers; Save changes; no keypad sheet. |
| Record / Edit workout / Saving / 1440 | `862:7983` | **Ready** · `862:8039` | W4 | Save in place; retained values; pending action cannot duplicate mutation. |
| Record / Edit workout / Saving / 390 | `482:1269` | **Ready** · `804:5923` | W4 | Save in place; retained values; pending action cannot duplicate mutation. |
| Record / Fix set / Refused load / 1440 | `482:1224` | **Ready** · `804:5926` | W4 | Refused load remains typed; inline error; focus failed field. |
| Record / Fix set / Refused load / 390 | `482:1312` | **Built** · `804:5929` | W4 | Refused load remains typed; inline error; focus failed field. |
| Record / Log / 2024 daily density / 1440 | `521:2521` | **Ready** · `804:5905` | W6 | Year-scoped dense history and counts; clearing restores scope. |
| Record / Log / 2024 daily density / 390 | `862:7546` | **Built** · `862:7595` | W6 | Year-scoped dense history and counts; clearing restores scope. |
| Record / Log / 2024 filter / 1440 | `518:2442` | **Ready** · `804:5887` | W6 | Filter reads 2024 with clear action; only matching history and totals. |
| Record / Log / 2024 filter / 390 | `518:2569` | **Built** · `804:5890` | W6 | Filter reads 2024 with clear action; only matching history and totals. |
| Record / Log / Daily density / 1440 | `519:2166` | **Ready** · `804:5899` | W6 | 982-workout fixture groups dense history; bounded scrolling/paging. |
| Record / Log / Daily density / 390 | `519:2797` | **Built** · `804:5902` | W6 | 982-workout fixture groups dense history; bounded scrolling/paging. |
| Record / Log / Default / 1440 | `470:8` | **Built** · `804:5863` | W2 | History index320 +24 gap +680 progress pane. |
| Record / Log / Default / 390 | `470:21` | **Built** · `804:5866` | W2 | Progress cards before history; footer Weigh in beside Add past workout for owner. |
| Record / Log / Jump to date / 1440 | `518:2340` | **Built** · `804:5881` | W6 | Date jump opens, selects range, and preserves remaining filters. |
| Record / Log / Jump to date / 390 | `518:2395` | **Built** · `804:5884` | W6 | Date jump opens, selects range, and preserves remaining filters. |
| Record / Log / No matches / 1440 | `518:2615` | **Built** · `804:5893` | W6 | Honest zero state; clear filters restores history. |
| Record / Log / No matches / 390 | `518:2658` | **Built** · `804:5896` | W6 | Honest zero state; clear filters restores history. |
| Record / Log / Previous workout / 1440 | `517:2282` | **Ready** · `804:5875` | W2 | Previous session selected and rendered with its actual sets. |
| Record / Log / Previous workout / 390 | `517:2441` | **Ready** · `804:5878` | W2 | Previous session selected and rendered with its actual sets. |
| Record / Log / Workout selected / 1440 | `470:34` | **Ready** · `804:5869` | W2 | Selected history row; reader in right pane; previous/next navigation. |
| Record / Log / Workout selected / 390 | `470:47` | **Ready** · `804:5872` | W2 | Workout opens dedicated reader; Back returns to log. |
| Record / Movement record / From workout / 1440 | `470:60` | **Built** · `804:5908` | W6 | Origin back link; 12 weeks/All; e1RM dots, honest gaps, standing best and set table. |
| Record / Movement record / From workout / 390 | `470:73` | **Built** · `804:5911` | W6 | Origin back link; 12 weeks/All; e1RM dots, honest gaps, standing best and set table. |
| Share / Link / Active / 1440 | `508:1814` | **Ready** · `804:6006` | W7 | Copy/view active link and revoke action; scope/expiry visible. |
| Share / Link / Active / 390 | `508:1888` | **Ready** · `804:6009` | W7 | Copy/view active link and revoke action; scope/expiry visible. |
| Share / Link / Revoked / 1440 | `508:1855` | **Ready** · `804:6012` | W7 | Revoked receipt; recipient access unavailable. |
| Share / Link / Revoked / 390 | `508:1923` | **Ready** · `804:6015` | W7 | Revoked receipt; recipient access unavailable. |
| Share / Preview / Default / 1440 | `524:3765` | **Ready** · `804:6000` | W7 | Read-only scope preview; create link only after preview. |
| Share / Preview / Default / 390 | `524:3906` | **Built** · `804:6003` | W7 | Read-only scope preview; create link only after preview. |
| Share / Recipient log / 2024 filter / 1440 | `524:3470` | **Ready** · `804:6042` | W7 | Read-only; Filter reads 2024 with clear action; only matching history and totals. |
| Share / Recipient log / 2024 filter / 390 | `524:3563` | **Built** · `804:6045` | W7 | Read-only; Filter reads 2024 with clear action; only matching history and totals. |
| Share / Recipient log / Default / 1440 | `524:2705` | **Built** · `804:6018` | W7 | Read-only; History index320 +24 gap +680 progress pane. |
| Share / Recipient log / Default / 390 | `524:2860` | **Built** · `804:6021` | W7 | Read-only; consistency line then history; no write controls. |
| Share / Recipient log / Jump to date / 1440 | `524:3372` | **Built** · `804:6036` | W7 | Read-only; Date jump opens, selects range, and preserves remaining filters. |
| Share / Recipient log / Jump to date / 390 | `524:3425` | **Built** · `804:6039` | W7 | Read-only; Date jump opens, selects range, and preserves remaining filters. |
| Share / Recipient log / No matches / 1440 | `524:3607` | **Built** · `804:6048` | W7 | Read-only; Honest zero state; clear filters restores history. |
| Share / Recipient log / No matches / 390 | `524:3648` | **Built** · `804:6051` | W7 | Read-only; Honest zero state; clear filters restores history. |
| Share / Recipient log / Previous workout / 1440 | `524:3184` | **Ready** · `804:6030` | W7 | Read-only; Previous session selected and rendered with its actual sets. |
| Share / Recipient log / Previous workout / 390 | `524:3309` | **Ready** · `804:6033` | W7 | Read-only; Previous session selected and rendered with its actual sets. |
| Share / Recipient log / Workout selected / 1440 | `524:2936` | **Ready** · `804:6024` | W7 | Read-only; Selected history row; reader in right pane; previous/next navigation. |
| Share / Recipient log / Workout selected / 390 | `524:3091` | **Ready** · `804:6027` | W7 | Read-only; Workout opens dedicated reader; Back returns to log. |
| Share / Setup / Date range · live / 1440 | `513:1938` | **Ready** · `804:5994` | W7 | Date range · live scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Date range · live / 390 | `513:2100` | **Ready** · `804:5997` | W7 | Date range · live scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Date range · snapshot / 1440 | `513:1825` | **Ready** · `804:5982` | W7 | Date range · snapshot scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Date range · snapshot / 390 | `513:1999` | **Ready** · `804:5985` | W7 | Date range · snapshot scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Entire history · live / 1440 | `513:1886` | **Ready** · `804:5988` | W7 | Entire history · live scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Entire history · live / 390 | `513:2054` | **Ready** · `804:5991` | W7 | Entire history · live scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Entire history · snapshot / 1440 | `508:1353` | **Ready** · `804:5976` | W7 | Entire history · snapshot scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Entire history · snapshot / 390 | `508:1407` | **Ready** · `804:5979` | W7 | Entire history · snapshot scope controls; include/exclude disclosure; Preview before create. |

## Runtime evidence gate

Evidence lives in `/tmp/gym-parity-2026-09-25`. Each board ID maps to
`figma-<id>-light.png` or `figma-<id>.png` and a state-specific runtime capture. The
`matrix.ndjson` metadata records dimensions, content bounds, browser errors and overflow checks.
The production comparison uses `production-<id>-<theme>.png` only after deployment verification.
A screenshot or a successful deployment alone does not establish visual acceptance.

| Area | Boards | Independent acceptance |
|---|---:|---|
| Plan | 20 | `review-plan.json`: routines, empty, editor, picker, ladder, conflict and Daylight |
| Record | 42 | `record-acceptance.json`: history, filters, density, movement, correction and past workout |
| Coach and Notes | 14 | `review-coach-share.json`: proposal, receipts, active workout, list and editors |
| Share | 26 | `review-coach-share.json`: setup, preview, link lifecycle and anonymous reader |

The state and behavior assertions run against isolated local accounts. The production frontend
check identifies deployed assets and runs those bytes against the same fixtures; separate
read-only production checks cover anonymous access and refusals. See
[web-verification.md](web-verification.md) for the exact current result and its limits.

## Structure observations

- Outer workspace width and intrinsic reading/figure limits have separate responsibilities.
  Focused, editor and history compositions belong in Gym; their widths do not alter shared chrome.
- Routine identity and its pending review share one card.
- Notes and Progress presentation live in their feature folders. Shared chart presentation is an
  explicit option and does not change the Bodyweight consumer.
- Verification includes sparse pages, six-set and error states, long forms and intermediate widths.
  A layout that fits a reference viewport still needs its actions checked at shorter heights.
