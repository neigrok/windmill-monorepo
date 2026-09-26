# Gym web build contract

[Web · Gym](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=466-132) holds the
editable screens. This contract owns their shared measurements and acceptance requirements.
Start and Components are reference sections.

The form rules live in [web-form.md](web-form.md); history, sharing and synthetic data live in
[log-exploration.md](log-exploration.md). The page groups Start, Components, Plan, Record,
Coach & Notes, and Share. Superseded boards leave the page.

## Shared frame and measurements

All authenticated boards inherit the shared frame. The shared app header is 52px high, with a 30px Windmill mark, centered Home/Roadmap/Journal/Gym links and a 30px account avatar. Side insets are 16px desktop and 12px at widths up to 480px. Routines, The log and Coach sit in a 64px bottom panel with a subtle top border; their group is centered horizontally, with 32px gaps and 50px touch targets. Active controls use brand ink, inactive controls faint ink. Pushed pages retain the bottom navigation. The runtime header consumes the top safe-area inset; the bottom panel consumes the bottom safe-area inset. Content scrolls in the space between them.

Content begins at y84 on both desktop and narrow screens. Narrow content x16/w358. Desktop
focused content is centered at x400/w640; figures keep a 420px intrinsic measure. The Log,
Coach, Notes and populated past-workout forms retain their centered 1024px workspaces at x208.
The routine editor is centered at x314/w812: 360px movements +32px gap +420px targets. A back link
remains a 44px row before the title and follows its content container. Shared header and
bottom-navigation geometry are unchanged.
These measurements describe the content contract. F59 in the [consistency ledger](../consistency.md) tracks the remaining navigation decision.

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

## State requirements

- Two boards explicitly depict Daylight Routines (`476:1082` and `476:1115`). Every other board is exported and compared using both Instrument and Daylight mode tokens. The shared shadow and warning bindings added for content parity are local to the Gym file and are not published.
- The Routines open menus in Instrument and Daylight contain Log past followed by Delete.
- Literal catalog spelling is current data: the editor/default fixture says Chin Up while some record fixtures say Chin-up. Do not rename backend records to imitate fixture typography.
- Native time inputs keep the user's system clock convention while editing. Backfill shows its selected value in a 24-hour resting label and the stored-hour disclosure.
- Shared shell components `468:2` and `468:13` retain the shared app header and place Gym navigation at the bottom. Their descriptions and Gym Tab `4:7` describe the current placement and content y84. Board status markers belong to Figma.
- The two Saved backfill boards reuse the current selected-reader composition (`470:34` and `470:47`) with the saved Undo receipt. Saving opens that reader; the form does not introduce a second workout presentation.
- The narrow New routine drawing includes the same required name input as desktop, with the missing-name reason beside Save. The input reuses the compact library component.
- Correction specimens use the current totals copy without set-kind terminology; both pending action specimens read Saving.
- All eight Coach conversation boards follow the current [feedback contract](feedback-contract.md): History and More in the heading, Add photo in the composer, and contextual limits. The composed boards reuse the quiet navigation control and system-bound Lucide icons. Runtime conversations retain their history, and deletion belongs in More. Content-sized desktop Apply and local spacing belong to the Ready visual gate.

## Acceptance

Compare each affected state at 1440 and 390 in both themes using live local fixture data.
[Web · Gym](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=466-132) owns the board
inventory and status markers; the [consistency ledger](../consistency.md) owns unresolved drift.
A passing unit test alone does not establish visual acceptance.

| Area | Required states |
|---|---|
| Planning | Empty/populated routines; new routine; movement picker; straight, varied and open targets; retained invalid input; reorder; stale-save conflict. |
| History | Default/selected/previous workout; full-history filters and date jump; empty results; dense history; preserved selection and scroll. |
| Entry and correction | Routine/free backfill, no routines, changed time, changed rows, overlap refusal, saved reader; correction loading, failure and successful persistence. |
| Coach and Notes | Empty/resumed conversation, active workout, proposal/apply/turn-down, loading and refusal; Notes list, new/edit note, limits and save failure. |
| Sharing | Whole-history/date-range and snapshot/live choices; recipient preview; link creation, expiry and revoke; anonymous history, filters, date jump and empty results. |

Preserve the distinct authenticated and public shells. Verify keyboard access, focus restoration,
large text, loading, offline and refusal states alongside the successful flows. Navigation drift
under F59 remains open; matching content proportions alone does not close it.
