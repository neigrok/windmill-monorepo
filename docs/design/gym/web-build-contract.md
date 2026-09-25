# Gym web build contract

Audit of [Web · Gym](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=466-132), 25 September 2026. The page contains 102 implementation boards in 51 desktop/narrow pairs: Plan 20, Record 42, Coach 14, Share 26. **All 102 boards are Built; none remain Ready**. Start and Components are reference sections, not implementation boards.

The acceptance gate is the [implementation plan](web-implementation-plan.md): running local web with live fixture data, at 1440 and 390, checked against each board. A code change or a passing unit test alone does not qualify a board as Built. The status-node column identifies the instance to update after that evidence exists.

## Shared frame and measurements

All authenticated boards inherit W1. The shared app header is 52px high, with a 30px Windmill mark, centered Home/Roadmap/Journal/Gym links and a 30px account avatar. Side insets are 16px desktop and 12px at widths up to 480px. Routines, The log and Coach sit in a 64px bottom panel with a subtle top border; their group is centered horizontally, with 32px gaps and 50px touch targets. Active controls use brand ink, inactive controls faint ink. Pushed pages retain the bottom navigation. The runtime header consumes the top safe-area inset; the bottom panel consumes the bottom safe-area inset. Content scrolls in the space between them.

Content begins at y84 on both desktop and narrow screens. Narrow content x16/w358. Desktop read-only and prose pages begin x208 with 640px reading measure; figures use 420px. The log uses a 1024px workspace. The routine editor uses 1092px: 640px movements +32px gap +420px targets, aligned x208 rather than centered independently. A back link is a 44px row before the title.

| Surface | Observed layout |
|---|---|
| Log selected 1440, `470:34` | Content x208/y84/w1024; index320 +24 gap +reader680; navigation44 high, reader with 12px gaps. |
| Log default 390, `470:21` | Content x16/y84/w358, gap16; progress before history. Progress cards gap24. History index is scrollable. Weigh in and Add past workout sit beside each other, 54px high in the 86px footer above navigation. |
| Routine editor 1440, `475:1050` | Split 640/32/420; ladder rows44 with4px gaps; content action band44 high. |
| Edit workout 1440, `482:1175` | Content x208/y84/w1024, section gaps32; editable form420; saved summary420 in right column; action band at content foot. |
| Coach 1440, `471:522` | Conversation x208/y84/w640; side rail x880/y84/w352; region gap16 and rail gap24. |
| Share setup 1440, `508:1353` | Content x208/y84; sections gap24; scope and update choices precede privacy panel and Preview. |
| Recipient log 1440, `524:2705` | Public header x208/y36/h24; snapshot line y82; content x208/y132/w1024. No authenticated shell or write controls. |

Set rows use a 10px rail with 2px ticks. Load × reps uses JetBrains Mono; the multiplication sign is faint. Equal sets collapse to a scheme; variable sets remain rows. Units appear once in a column head or total. Add set is last. Row actions reveal on hover/focus, not layout shift. History rows are 48px in the actual index component (an exception to the generic 44/56 rule in web-form.md).

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

Use existing token aliases, not these verification hex values as new literals. Instrument: canvas #0b1111, surface #161c1d, line #202627, strong line #2a3133, ink #f1f0eb, dim #b6b5af, faint #727771, brand #5fcdb4, accent ink #1b1408, PR #d9b04c. Daylight: canvas #ebe7e3, surface #f8f6f4, ink #1a1918, dim #4c4744, faint #625c58, brand #4c4374, accent ink white. Colour is bound to Gym · Colour; spaces/radii/measures to Gym · Metrics.

Card radius 16 is the general rule. Existing progress cards, editable rows and local action-band buttons bind radius/md 12. Spacing follows 4px increments. Do not flatten all component radii to one value.

Daylight PR ink uses the approved gold-700 `#6E5217`, with the existing 14% gold-600 PR tint. The
plain/tinted contrast pairs are canvas 5.92/5.13, card 6.76/5.79 and raised 5.25/4.60. Figma token
`VariableID:872:7735` and specimen `874:7735` are the source; native lag is tracked in F4.

Feedback follows web-form.md: row hover 150ms, underline 180ms, number change 280ms, add 280ms, remove 180ms, saved readout 900ms, proposal transition 280ms. Reduced motion preserves colour changes and removes movement.

## High-fidelity context references

Screenshots and full design contexts were retrieved for `470:34`, `470:21`, `475:1050`, `482:1175`, `470:8`, `470:60`, `471:522`, `472:251`, `508:1353`, `524:2705`, and `476:1082`. These cover the shell, both log compositions, editor, correction, movement record, Coach, note editor, sharing setup, recipient and Daylight. Generated code is a visual reference; adapt it to the existing React components and token CSS. Small arrow/door assets are static and must use the exact supplied asset or an exact existing match; charts represent dynamic session data.

## Implementation decisions

- Full Daylight drawings exist only for Routines (`476:1082` and `476:1115`). The additional W8 runtime matrix verifies the other layouts with Daylight mode tokens. The Gym library is published to Sam Gold's team; Manage libraries confirms No changes after the token and Logger component update.
- The implementation uses current mode tokens for Daylight layouts without full drawings. The runtime theme matrix below is verified in addition to the two drawn Daylight routine boards.
- The Routines open menus in Instrument and Daylight contain Log past followed by Delete.
- Literal catalog spelling is current data: the editor/default fixture says Chin Up while some record fixtures say Chin-up. Do not rename backend records to imitate fixture typography.
- Native time inputs keep the user's system clock convention. The stored-hour disclosure must reflect the actual selected value; a 24-hour picture alone does not require a custom time widget.
- Shared shell components `468:2` and `468:13` retain the shared app header and place Gym navigation at the bottom. Their descriptions and Gym Tab `4:7` describe the current placement and content y84. The board status column records the current verified build state.
- The two Saved backfill boards reuse the current selected-reader composition (`470:34` and `470:47`) with the saved Undo receipt. Saving opens that reader; the form does not introduce a second workout presentation.
- The narrow New routine drawing includes the same required name input as desktop, with the missing-name reason beside Save. The input reuses the compact library component.
- Correction specimens use the current totals copy without set-kind terminology; both pending action specimens read Saving.
- All eight Coach conversation boards follow the current [feedback contract](feedback-contract.md): History and More in the heading, Add photo in the composer, and contextual limits. The composed boards reuse the quiet navigation control and system-bound Lucide icons; proposal masters retain their current layout. Runtime conversations retain their history, and deletion belongs in More.

## Daylight runtime matrix

Each capture stem below has both 1440 and 390 widths. Instrument geometry remains the reference;
Daylight uses the approved mode tokens, legible ink and quiet surfaces. All listed surfaces and
state-specific board gates pass. Native token lag and unused library glow values remain separate ledger entries.

| Surface | Verified Daylight evidence | Remaining gate |
|---|---|---|
| Routines and editing | `routines-daylight-final-{w}`, `accepted-editor-light-{w}`, `accepted-new-routine-light-{w}`, `{picker,sixsets,copydown}-final-light-{w}` | None for the core forms, picker and target ladder. |
| Log, reader, correction and movement | `final-log-light-{w}`, `qa-reader-selected-light-{w}`, `final-correction-light-{w}`, `movement-final-light-{w}`, `fix-refused-final-light-{w}`, `correction-saving-{top-final,final}-light-{w}` | None. |
| Notes | `accepted-notes-light-{w}`, `accepted-note-existing-light-{w}`, `accepted-note-new-light-{w}` | None. |
| Coach | `coach-{proposal,applied,dismissed,workout}-final-light-{w}` | None. |
| Backfill | `backfill-{picker,prefilled,empty,free,edited}-final-light-{w}`, `backfill-edited-bottom-final-light-{w}`, `backfill-time-final-light-1440`, `backfill-time-width-final-light-390`, `backfill-overlap-bottom-final-light-{w}`, `backfill-saved-final-light-{w}` | None. |
| Sharing setup and links | `w7-setup-{all-snapshot,all-live,range-snapshot,range-live}-light-{w}`, `w7-{active,revoked}-light-{w}` | None. |
| Public log | `w7-recipient-{default,selected,previous,zero,revoked,date-2024,filtered-2024}-light-{w}`, `w7-preview-{snapshot,footer}-light-{w}` | None. |

## Board acceptance map

W1 applies to every authenticated board. The principal wave counts are W2 24, W3 18, W4 6, W5 14, W6 12, W7 26, W8 2. Each status cell records the current Figma status.

| Board | Node | Status / node | Wave | Acceptance |
|---|---|---|---|---|
| Coach / Conversation / Applied / 1440 | `473:285` | **Built** · `804:5945` | W5 | Proposal message becomes applied receipt; changed targets visible. |
| Coach / Conversation / Applied / 390 | `473:350` | **Built** · `804:5948` | W5 | Proposal message becomes applied receipt; changed targets visible. |
| Coach / Conversation / Proposal / 1440 | `471:522` | **Built** · `804:5933` | W5 | Inline diff; Push A · 1 change; Apply then Turn this down; composer fits. |
| Coach / Conversation / Proposal / 390 | `471:537` | **Built** · `804:5936` | W5 | Inline diff; Push A · 1 change; Apply then Turn this down; composer fits. |
| Coach / Conversation / Turned down / 1440 | `493:1404` | **Built** · `804:5939` | W5 | Proposal message becomes declined receipt in place. |
| Coach / Conversation / Turned down / 390 | `493:1488` | **Built** · `804:5942` | W5 | Proposal message becomes declined receipt in place. |
| Coach / Conversation / Workout in progress / 1440 | `473:331` | **Built** · `804:5951` | W5 | Live-session context; Coach proposes only; no web Start. |
| Coach / Conversation / Workout in progress / 390 | `473:393` | **Built** · `804:5954` | W5 | Live-session context; Coach proposes only; no web Start. |
| Coach / Note editor / Existing note / 1440 | `472:251` | **Built** · `804:5963` | W5 | Edit note heading, disclosure, title/body limits, Save and Cancel. |
| Coach / Note editor / Existing note / 390 | `472:317` | **Built** · `804:5966` | W5 | Edit note heading, disclosure, title/body limits, Save and Cancel. |
| Coach / Note editor / New note / 1440 | `482:1099` | **Built** · `804:5969` | W5 | New note heading, disclosure, title/body limits, Save and Cancel. |
| Coach / Note editor / New note / 390 | `482:1136` | **Built** · `804:5972` | W5 | New note heading, disclosure, title/body limits, Save and Cancel. |
| Coach / Notes / Default / 1440 | `472:215` | **Built** · `804:5957` | W5 | Notes heading and connected-agent disclosure; note rows open editor. |
| Coach / Notes / Default / 390 | `472:281` | **Built** · `804:5960` | W5 | Notes heading and connected-agent disclosure; note rows open editor. |
| Plan / New routine / Default / 1440 | `480:1556` | **Built** · `804:5847` | W3 | Name draft; selected movement targets; Add movement; create only on Save. |
| Plan / New routine / Default / 390 | `862:7256` | **Built** · `862:7313` | W3 | Name draft; selected movement targets; Add movement; create only on Save. |
| Plan / New routine / Picker / 1440 | `862:7370` | **Built** · `862:7436` | W3 | Search and select movements in editor right pane. |
| Plan / New routine / Picker / 390 | `480:1504` | **Built** · `804:5850` | W3 | Search and select movements in narrow sheet. |
| Plan / Routine editor / Conflict / 1440 | `475:1238` | **Built** · `804:5853` | W3 | Keep draft; show latest routine; explicit conflict recovery. |
| Plan / Routine editor / Conflict / 390 | `862:7478` | **Built** · `862:7543` | W3 | Keep draft; show latest routine; explicit conflict recovery. |
| Plan / Routine editor / Copy-down / 1440 | `485:1341` | **Built** · `804:5841` | W3 | Fill menu copies load/reps down without changing mode. |
| Plan / Routine editor / Copy-down / 390 | `480:1614` | **Built** · `804:5844` | W3 | Fill menu copies load/reps down without changing mode. |
| Plan / Routine editor / Default / 1440 | `475:1050` | **Built** · `804:5826` | W3 | 640px movement list +32px gap +420px ladder pane; persistent draft. |
| Plan / Routine editor / Default / 390 | `475:1106` | **Built** · `804:5829` | W3 | Movement list; selected targets open in sheet; persistent draft. |
| Plan / Routine editor / Ladder / 1440 | `485:1254` | **Built** · `804:5835` | W3 | Variable per-set targets; Every set and Set by set both visible. |
| Plan / Routine editor / Ladder / 390 | `480:1387` | **Built** · `804:5838` | W3 | Variable per-set targets; Every set and Set by set both visible. |
| Plan / Routine editor / Six sets / 1440 | `862:7051` | **Built** · `862:7133` | W3 | Right pane contains six editable sets and Add set last. |
| Plan / Routine editor / Six sets / 390 | `475:1156` | **Built** · `804:5832` | W3 | Sheet contains six editable sets and Add set last. |
| Plan / Routines / Daylight / 1440 | `476:1082` | **Built** · `804:5856` | W8 | Daylight tokens; same routine list and interactions. |
| Plan / Routines / Daylight / 390 | `476:1115` | **Built** · `804:5859` | W8 | Daylight tokens; same routine list and interactions. |
| Plan / Routines / Default / 1440 | `475:892` | **Built** · `804:5814` | W3 | Your routines; card opens draft; movement names and grouped rail; New routine. |
| Plan / Routines / Default / 390 | `475:945` | **Built** · `804:5817` | W3 | Your routines; card opens draft; movement names and grouped rail; New routine. |
| Plan / Routines / Empty / 1440 | `475:992` | **Built** · `804:5820` | W3 | Empty plan invitation; New routine action. |
| Plan / Routines / Empty / 390 | `475:1024` | **Built** · `804:5823` | W3 | Empty plan invitation; New routine action. |
| Record / Add past workout / Edited / 1440 | `834:7731` | **Built** · `834:7752` | W2 | Retain changed values and added/removed rows; one atomic Save. |
| Record / Add past workout / Edited / 390 | `834:7956` | **Built** · `834:7971` | W2 | Retain changed values and added/removed rows; one atomic Save. |
| Record / Add past workout / Free session / 1440 | `835:7226` | **Built** · `835:7247` | W2 | Blank session accepts movement rows without changing a routine. |
| Record / Add past workout / Free session / 390 | `835:7323` | **Built** · `835:7338` | W2 | Blank session accepts movement rows without changing a routine. |
| Record / Add past workout / From a routine / 1440 | `832:7458` | **Built** · `832:7564` | W2 | Routine menu Log past enters prefilled session; plan is unchanged. |
| Record / Add past workout / From a routine / 390 | `835:15047` | **Built** · `835:15146` | W2 | Routine menu Log past enters prefilled session; plan is unchanged. |
| Record / Add past workout / No routines / 1440 | `835:7387` | **Built** · `835:7408` | W2 | Empty routine choice; Free session remains usable. |
| Record / Add past workout / No routines / 390 | `835:7438` | **Built** · `835:7453` | W2 | Empty routine choice; Free session remains usable. |
| Record / Add past workout / Overlap refusal / 1440 | `835:6896` | **Built** · `835:6917` | W2 | Retain complete draft; explain overlap refusal; reopen offending control. |
| Record / Add past workout / Overlap refusal / 390 | `835:7075` | **Built** · `835:7090` | W2 | Retain complete draft; explain overlap refusal; reopen offending control. |
| Record / Add past workout / Pick routine / 1440 | `834:7279` | **Built** · `834:7300` | W2 | Routine picker fills target/last-time values; Free session alternative. |
| Record / Add past workout / Pick routine / 390 | `834:7339` | **Built** · `834:7354` | W2 | Routine picker fills target/last-time values; Free session alternative. |
| Record / Add past workout / Prefilled / 1440 | `834:7393` | **Built** · `834:7414` | W2 | Editable prefilled targets; one-tap day; default hour disclosed beside Save. |
| Record / Add past workout / Prefilled / 390 | `834:7576` | **Built** · `834:7591` | W2 | Editable prefilled targets; one-tap day; default hour disclosed beside Save. |
| Record / Add past workout / Saved / 1440 | `835:7481` | **Built** · `835:7502` | W2 | Return to log split with newly saved workout selected. |
| Record / Add past workout / Saved / 390 | `835:7623` | **Built** · `835:7638` | W2 | Open saved workout detail with actual values. |
| Record / Add past workout / Time changed / 1440 | `835:6578` | **Built** · `835:6599` | W2 | Native hour input; Save disclosure reflects stored time. |
| Record / Add past workout / Time changed / 390 | `835:6751` | **Built** · `835:6766` | W2 | Native hour input; Save disclosure reflects stored time. |
| Record / Edit workout / Default / 1440 | `482:1175` | **Built** · `804:5920` | W4 | Inline metadata and editable numbers; Save changes; no keypad sheet. |
| Record / Edit workout / Default / 390 | `862:7838` | **Built** · `862:7882` | W4 | Inline metadata and editable numbers; Save changes; no keypad sheet. |
| Record / Edit workout / Saving / 1440 | `862:7983` | **Built** · `862:8039` | W4 | Save in place; retained values; pending action cannot duplicate mutation. |
| Record / Edit workout / Saving / 390 | `482:1269` | **Built** · `804:5923` | W4 | Save in place; retained values; pending action cannot duplicate mutation. |
| Record / Fix set / Refused load / 1440 | `482:1224` | **Built** · `804:5926` | W4 | Refused load remains typed; inline error; focus failed field. |
| Record / Fix set / Refused load / 390 | `482:1312` | **Built** · `804:5929` | W4 | Refused load remains typed; inline error; focus failed field. |
| Record / Log / 2024 daily density / 1440 | `521:2521` | **Built** · `804:5905` | W6 | Year-scoped dense history and counts; clearing restores scope. |
| Record / Log / 2024 daily density / 390 | `862:7546` | **Built** · `862:7595` | W6 | Year-scoped dense history and counts; clearing restores scope. |
| Record / Log / 2024 filter / 1440 | `518:2442` | **Built** · `804:5887` | W6 | Filter reads 2024 with clear action; only matching history and totals. |
| Record / Log / 2024 filter / 390 | `518:2569` | **Built** · `804:5890` | W6 | Filter reads 2024 with clear action; only matching history and totals. |
| Record / Log / Daily density / 1440 | `519:2166` | **Built** · `804:5899` | W6 | 982-workout fixture groups dense history; bounded scrolling/paging. |
| Record / Log / Daily density / 390 | `519:2797` | **Built** · `804:5902` | W6 | 982-workout fixture groups dense history; bounded scrolling/paging. |
| Record / Log / Default / 1440 | `470:8` | **Built** · `804:5863` | W2 | History index320 +24 gap +680 progress pane. |
| Record / Log / Default / 390 | `470:21` | **Built** · `804:5866` | W2 | Progress cards before history; footer Weigh in beside Add past workout for owner. |
| Record / Log / Jump to date / 1440 | `518:2340` | **Built** · `804:5881` | W6 | Date jump opens, selects range, and preserves remaining filters. |
| Record / Log / Jump to date / 390 | `518:2395` | **Built** · `804:5884` | W6 | Date jump opens, selects range, and preserves remaining filters. |
| Record / Log / No matches / 1440 | `518:2615` | **Built** · `804:5893` | W6 | Honest zero state; clear filters restores history. |
| Record / Log / No matches / 390 | `518:2658` | **Built** · `804:5896` | W6 | Honest zero state; clear filters restores history. |
| Record / Log / Previous workout / 1440 | `517:2282` | **Built** · `804:5875` | W2 | Previous session selected and rendered with its actual sets. |
| Record / Log / Previous workout / 390 | `517:2441` | **Built** · `804:5878` | W2 | Previous session selected and rendered with its actual sets. |
| Record / Log / Workout selected / 1440 | `470:34` | **Built** · `804:5869` | W2 | Selected history row; reader in right pane; previous/next navigation. |
| Record / Log / Workout selected / 390 | `470:47` | **Built** · `804:5872` | W2 | Workout opens dedicated reader; Back returns to log. |
| Record / Movement record / From workout / 1440 | `470:60` | **Built** · `804:5908` | W6 | Origin back link; 12 weeks/All; e1RM dots, honest gaps, standing best and set table. |
| Record / Movement record / From workout / 390 | `470:73` | **Built** · `804:5911` | W6 | Origin back link; 12 weeks/All; e1RM dots, honest gaps, standing best and set table. |
| Share / Link / Active / 1440 | `508:1814` | **Built** · `804:6006` | W7 | Copy/view active link and revoke action; scope/expiry visible. |
| Share / Link / Active / 390 | `508:1888` | **Built** · `804:6009` | W7 | Copy/view active link and revoke action; scope/expiry visible. |
| Share / Link / Revoked / 1440 | `508:1855` | **Built** · `804:6012` | W7 | Revoked receipt; recipient access unavailable. |
| Share / Link / Revoked / 390 | `508:1923` | **Built** · `804:6015` | W7 | Revoked receipt; recipient access unavailable. |
| Share / Preview / Default / 1440 | `524:3765` | **Built** · `804:6000` | W7 | Read-only scope preview; create link only after preview. |
| Share / Preview / Default / 390 | `524:3906` | **Built** · `804:6003` | W7 | Read-only scope preview; create link only after preview. |
| Share / Recipient log / 2024 filter / 1440 | `524:3470` | **Built** · `804:6042` | W7 | Read-only; Filter reads 2024 with clear action; only matching history and totals. |
| Share / Recipient log / 2024 filter / 390 | `524:3563` | **Built** · `804:6045` | W7 | Read-only; Filter reads 2024 with clear action; only matching history and totals. |
| Share / Recipient log / Default / 1440 | `524:2705` | **Built** · `804:6018` | W7 | Read-only; History index320 +24 gap +680 progress pane. |
| Share / Recipient log / Default / 390 | `524:2860` | **Built** · `804:6021` | W7 | Read-only; consistency line then history; no write controls. |
| Share / Recipient log / Jump to date / 1440 | `524:3372` | **Built** · `804:6036` | W7 | Read-only; Date jump opens, selects range, and preserves remaining filters. |
| Share / Recipient log / Jump to date / 390 | `524:3425` | **Built** · `804:6039` | W7 | Read-only; Date jump opens, selects range, and preserves remaining filters. |
| Share / Recipient log / No matches / 1440 | `524:3607` | **Built** · `804:6048` | W7 | Read-only; Honest zero state; clear filters restores history. |
| Share / Recipient log / No matches / 390 | `524:3648` | **Built** · `804:6051` | W7 | Read-only; Honest zero state; clear filters restores history. |
| Share / Recipient log / Previous workout / 1440 | `524:3184` | **Built** · `804:6030` | W7 | Read-only; Previous session selected and rendered with its actual sets. |
| Share / Recipient log / Previous workout / 390 | `524:3309` | **Built** · `804:6033` | W7 | Read-only; Previous session selected and rendered with its actual sets. |
| Share / Recipient log / Workout selected / 1440 | `524:2936` | **Built** · `804:6024` | W7 | Read-only; Selected history row; reader in right pane; previous/next navigation. |
| Share / Recipient log / Workout selected / 390 | `524:3091` | **Built** · `804:6027` | W7 | Read-only; Workout opens dedicated reader; Back returns to log. |
| Share / Setup / Date range · live / 1440 | `513:1938` | **Built** · `804:5994` | W7 | Date range · live scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Date range · live / 390 | `513:2100` | **Built** · `804:5997` | W7 | Date range · live scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Date range · snapshot / 1440 | `513:1825` | **Built** · `804:5982` | W7 | Date range · snapshot scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Date range · snapshot / 390 | `513:1999` | **Built** · `804:5985` | W7 | Date range · snapshot scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Entire history · live / 1440 | `513:1886` | **Built** · `804:5988` | W7 | Entire history · live scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Entire history · live / 390 | `513:2054` | **Built** · `804:5991` | W7 | Entire history · live scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Entire history · snapshot / 1440 | `508:1353` | **Built** · `804:5976` | W7 | Entire history · snapshot scope controls; include/exclude disclosure; Preview before create. |
| Share / Setup / Entire history · snapshot / 390 | `508:1407` | **Built** · `804:5979` | W7 | Entire history · snapshot scope controls; include/exclude disclosure; Preview before create. |

## Runtime evidence gate

Local screenshot evidence lives in `/private/tmp/windmill-gym-web-verify`. The table maps every board pair to its current evidence and remaining gate. A capture alone is not a visual pass. All 51 pairs have their named layout, state and runtime behavior checked at both widths. Final Figma readback confirms 102 Built, zero Ready. Invalid-route screenshots are excluded.

F4 is verified independently: runtime PR ink resolves to `#D9B04C` in Instrument and `#6E5217` in Daylight. The current log, reader, and correction routes were captured in both themes at both widths with no horizontal overflow and no browser exceptions. The state-specific evidence is recorded below.

| Board pair | Nodes 1440 / 390 | Runtime captures (`{w}` = 1440 and 390) | Remaining gate |
|---|---|---|---|
| Coach / Conversation / Applied | `473:285` / `473:350` | `coach-applied-final-dark-{w}.png` | Built. Both themes and inline applied receipt verified; owner confirmed exact mutation and fixture restoration. |
| Coach / Conversation / Proposal | `471:522` / `471:537` | `coach-proposal-final-dark-{w}.png` | Built. Both themes, inline diff, Apply, decline, current feedback chrome and composer verified. |
| Coach / Conversation / Turned down | `493:1404` / `493:1488` | `coach-dismissed-final-dark-{w}.png` | Built. Both themes and faint receipt verified; decline leaves routine unchanged. |
| Coach / Conversation / Workout in progress | `473:331` / `473:393` | `coach-workout-final-dark-{w}.png` | Built. Both themes, actual two-set session, frozen-plan mirror, refusal, View workout focus/reveal and Notes access verified; no composer, Apply, live controls or model requests. Temporary session removed. |
| Coach / Note editor / Existing note | `472:251` / `472:317` | `accepted-note-existing-dark-{w}.png` | Built. Visual form and near-limit byte meter pass in both themes; owner verified edit/delete/retention. |
| Coach / Note editor / New note | `482:1099` / `482:1136` | `accepted-note-new-dark-{w}.png` | Built. Clean new form and disabled Save pass in both themes; owner verified create/cancel. |
| Coach / Notes / Default | `472:215` / `472:281` | `notes-list-final-{w}.png` | Built. Canvas rows, active rail, typography and disclosure compared at both widths; Notes CRUD/reorder verified by owner. |
| Plan / New routine / Default | `480:1556` / `862:7256` | `routine-unnamed-final-{w}.png` | Built. Unnamed Bench Press draft, three targets, name input, disabled Save reason and narrow adjacent Draft verified. |
| Plan / New routine / Picker | `862:7370` / `480:1504` | `picker-final-{w}.png` | Built. Six plain movement rows, search, plus affordance, New movement and desktop pane/narrow sheet verified. |
| Plan / Routine editor / Conflict | `475:1238` / `862:7478` | `conflict-live-{w}.png` | Built. Both comparisons and differences verified; conflict-footer-live captures show reachable recovery actions. Keep both preserves saved version. |
| Plan / Routine editor / Copy-down | `485:1341` / `480:1614` | `copydown-live-{w}.png` | Built. Load copied into all six rows, equal-set summary and closed shared editor structure verified. |
| Plan / Routine editor / Default | `475:1050` / `475:1106` | `editor-closed-final-{w}.png` | Built. Desktop split, narrow movement list, selected target editing, Save and retained draft verified. |
| Plan / Routine editor / Ladder | `485:1254` / `480:1387` | `ladder-live-{w}.png` | Built. Variable targets, Every set and Set by set, narrow sheet and Save verified. |
| Plan / Routine editor / Six sets | `862:7051` / `475:1156` | `sixsets-live-{w}.png` | Built. Six editable rows, Add set last and narrow Set action verified. |
| Plan / Routines / Daylight | `476:1082` / `476:1115` | `routines-daylight-final-{w}.png` | Built. Mode palette, compact cards, grouped rails and pill New routine verified at both widths. |
| Plan / Routines / Default | `475:892` / `475:945` | `routine-menu-final-{w}.png` | Built. Compact cards, grouped rail, pill New routine and contextual menu verified. |
| Plan / Routines / Empty | `475:992` / `475:1024` | `routines-empty-final-{w}.png` | Built. Centered quiet empty copy and New routine action verified; narrow 500px card. |
| Record / Add past workout / Edited | `834:7731` / `834:7956` | `backfill-edited-final-dark-{w}.png` | Built. Both themes, copy-down, fourth set, added movement with committed 40×10, removed-movement Undo and enabled eight-set Save verified; bottom-final captures include the full form. |
| Record / Add past workout / Free session | `835:7226` / `835:7323` | `backfill-free-final-dark-{w}.png` | Built. Both themes, last-time movement prefill, plain narrow row and enabled Save verified; routine remains unchanged. |
| Record / Add past workout / From a routine | `832:7458` / `835:15047` | `routine-menu-final-{w}.png` | Built. 180×98 Log past/Delete menu and prefilled route verified; live plan stays unchanged. |
| Record / Add past workout / No routines | `835:7387` / `835:7438` | `backfill-no-routines-final-{w}.png` | Built. Empty-routine disclosure, Build a routine, usable free form and disabled empty Save verified. |
| Record / Add past workout / Overlap refusal | `835:6896` / `835:7075` | `backfill-overlap-bottom-final-dark-{w}.png` | Built. Both themes, actual conflicting session disclosure, retained three-movement draft, recovery actions and disabled Save verified; top form is in backfill-overlap-final captures. |
| Record / Add past workout / Pick routine | `834:7279` / `834:7339` | `backfill-picker-final-dark-{w}.png` | Built. Both themes, routine rows, narrow Back/title spacing and Free session alternative verified. |
| Record / Add past workout / Prefilled | `834:7393` / `834:7576` | `backfill-prefilled-final-dark-{w}.png` | Built. Both themes, targets and last-time rail, one-tap day, narrow plain rows and truthful default-hour disclosure verified. |
| Record / Add past workout / Saved | `835:7481` / `835:7623` | `backfill-saved-final-dark-{w}.png` | Built. Both themes, top-of-page selected landing, actual 9/66/2160 totals, three movements and saved Undo receipt verified; scratch workouts cleaned. |
| Record / Add past workout / Time changed | `835:6578` / `835:6751` | `backfill-time-final-dark-{w}.png` | Built. Native 18:15, duration and matching 18:15–19:15 disclosure verified in both themes. Narrow final evidence is backfill-time-width-final-{dark,light}-390; full PM segment and duration group fit. |
| Record / Edit workout / Default | `482:1175` / `862:7838` | `final-correction-{w}.png` | Built. Columns, native time field and editable rows verified in both themes; root passed add/edit/save/readback. |
| Record / Edit workout / Saving | `862:7983` / `482:1269` | `correction-saving-final-dark-{w}.png` | Built. Both themes, retained 62.5 edit, nine disabled inputs in faint ink, disabled Saving action, visible footer and successful correction persistence verified; top-final captures include shell. |
| Record / Fix set / Refused load | `482:1224` / `482:1312` | `fix-refused-final-dark-{w}.png` | Built. Both themes, dedicated page, neighboring sets, retained 625 and focused inline refusal, RPE chips and underlined note verified. |
| Record / Log / 2024 daily density | `521:2521` / `862:7546` | `final-density-2024-{w}.png` | Built. 366-workout scope, month groups and narrow history verified; root passed clearing scope. |
| Record / Log / 2024 filter | `518:2442` / `518:2569` | `final-log-2024-{w}.png` | Built. Scoped counts/history, desktop first matching selection and narrow history-first layout verified. |
| Record / Log / Daily density | `519:2166` / `519:2797` | `final-density-default-{w}.png` | Built. 982-workout fixture, month groups, desktop reader and narrow history verified; root passed deep navigation. |
| Record / Log / Default | `470:8` / `470:21` | `final-log-default-{w}.png` | Built. Desktop split and narrow progress-first layout verified; compact labels no longer collide. |
| Record / Log / Jump to date | `518:2340` / `518:2395` | `final-date-jump-{w}.png` | Built. Desktop 420px popover and narrow bottom sheet/scrim verified; root passed year/filter behavior. |
| Record / Log / No matches | `518:2615` / `518:2658` | `final-log-no-matches-{w}.png` | Built. Known movement/year zero state, clear action and desktop/narrow composition verified. |
| Record / Log / Previous workout | `517:2282` / `517:2441` | `final-reader-previous-{w}.png` | Built. Previous selection and actual sets verified; no extra Progress below reader. |
| Record / Log / Workout selected | `470:34` / `470:47` | `final-reader-selected-{w}.png` | Built. Selected row, reader, previous/next and narrow Edit action verified. |
| Record / Movement record / From workout | `470:60` / `470:73` | `movement-final-dark-{w}.png` | Built. Both themes, origin/scroll reset, 12-week chart/table and All eight-session series verified; complete dots and cross-year labels pass in movement-all-final captures. |
| Share / Link / Active | `508:1814` / `508:1888` | `w7-active-dark-{w}.png` | Built. Both themes, scoped receipt, long-link ellipsis, full copied URL and revoke behavior verified. |
| Share / Link / Revoked | `508:1855` / `508:1923` | `share-revoked-{w}.png` | Built. Receipt card, full-width narrow New link and anonymous unavailable behavior verified. |
| Share / Preview / Default | `524:3765` / `524:3906` | `w7-preview-snapshot-dark-{w}.png` | Built. Both themes, scope and reader preview, no create mutation before confirmation, and reachable Create link footer verified in w7-preview-footer captures. |
| Share / Recipient log / 2024 filter | `524:3470` / `524:3563` | `w7-recipient-filtered-2024-dark-{w}.png` | Built. Both themes, two-workout scope, desktop first matching June 10 reader and narrow history-only layout verified. |
| Share / Recipient log / Default | `524:2705` / `524:2860` | `recipient-final-{w}.png` | Built. Anonymous all-history snapshot, desktop progress split, narrow history, body scope totals and three filters verified. |
| Share / Recipient log / Jump to date | `524:3372` / `524:3425` | `w7-recipient-date-2024-dark-{w}.png` | Built. Both themes, loaded two-row history, selected year, desktop popover and narrow bottom sheet verified. |
| Share / Recipient log / No matches | `524:3607` / `524:3648` | `recipient-empty-final-{w}.png` | Built. Desktop zero card, narrow centered zero region, brand Clear filters and no Progress verified. |
| Share / Recipient log / Previous workout | `524:3184` / `524:3309` | `recipient-previous-final-{w}.png` | Built. Previous session and actual sets, selected history, scope disclosure and dedicated narrow reader verified. |
| Share / Recipient log / Workout selected | `524:2936` / `524:3091` | `recipient-reader-final-{w}.png` | Built. Anonymous selected reader, scope disclosure, teal completed-set marks and narrow The log navigation verified. |
| Share / Setup / Date range · live | `513:1938` / `513:2100` | `share-range-final-{w}.png` | Built. Date range/live selection, native dates, privacy disclosure and visible narrow Preview verified. |
| Share / Setup / Date range · snapshot | `513:1825` / `513:1999` | `w7-setup-range-snapshot-dark-{w}.png` | Built. Both themes, native dates, scoped counts, snapshot selection and visible narrow Preview verified. |
| Share / Setup / Entire history · live | `513:1886` / `513:2054` | `w7-setup-all-live-dark-{w}.png` | Built. Both themes, live selection and update disclosure, privacy and visible narrow Preview verified. |
| Share / Setup / Entire history · snapshot | `508:1353` / `508:1407` | `w7-setup-all-snapshot-dark-{w}.png` | Built. Both themes, all-history snapshot default, privacy disclosure and visible narrow Preview verified. |
