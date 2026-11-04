# Roadmap web reconciliation

Current evidence: 2026-10-24. Canonical delivery drawings are on separate
[Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=130-2) and
[Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-2) pages.
The finite source audit covers all 23 current Roadmap screen/state families below. Web has 54
reconciled flow/state boards plus three support blocks in ten sections; Web Mobile has 39
reconciled boards plus two owner links in ten sections. These are composition and state specimens,
not 98 distinct routes. Shared state families use component variants instead of duplicate full screens.

## Status and ownership

🚀 In production marks a drawing reconciled with the current implementation. Source comparison
establishes conditional states; runtime evidence is recorded separately. The marker does not claim
a remote deployment check, every branch exercised, bug-free behavior, or new human design approval.
All current Roadmap flow/state boards are reconciled. 🧩 identifies reusable components and owner
links. Existing AI Review/Apply remains a 💡 proposal awaiting human review. The Board has its own pages
([proposal](roadmap-board-proposal.md)); the List boards on Web Mobile describe a view the product no longer has, and the
designer deletes them in the 🚀 pass.

Web and Web Mobile are separate. Product primitives live on Components; helper-local settings and
shortcut primitives remain beside their variants. Shared Shell/Home drawings are thin links to their
canonical owner, avoiding competing copies. Numbered flow sections and the [thin index](../index.md#roadmap--web)
provide navigation. This phase changes drawings and documentation only.

The model is locked/available/complete. Bubble is the default layout. Owners default to the Board on
every band and visitors to the Graph; birth trees open on the Graph, and an owner's empty tree on the
Board. Phone is below 744px, tablet 744–1023px, desktop 1024px and up. Tablet panel 320px, desktop
inspector 360px. No checkout is offered: `paidPlansOpen()` is false and PlanSection is not registered.

## Exhaustive current-family map

Paths are relative to `web/src/products/roadmap/`. An exact node can be a complete screen, an overlay,
or a reusable state specimen. Repeated server-error strings share their named component faces.
No-render branches are documented as gates rather than invented screens.

| ID | Current family | Figma nodes | Source |
|---|---|---|---|
| 01 | Resolution, load/error, desktop empty, HomeCard | [35:24](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=35-24), [41:31](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=41-31), [36:91](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=36-91) | `SkillTreeApp.jsx; SkillTreeView.jsx; HomeCard.jsx` |
| 02 | Local/synced/lapsed, capacity/refused save, ownership demotion | [47:49](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=47-49) | `room/HonestyChrome.jsx; SkillTreeView.jsx` |
| 03 | Quest roster, phone shelf, split start, planting/failure | [45:428](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=45-428), [184:797](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-797), [184:1237](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1237) | `quests/QuestShelf.jsx; quests/QuestThumb.jsx` |
| 04 | Blank birth, name, planting/failure, paste/file drop | [42:37](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=42-37), [42:61](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=42-61), [184:1237](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1237) | `paste/NewTreeBirth.jsx` |
| 05 | Paste/append, parsing/legend, optional name, ghost, all Shape phases | [44:71](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=44-71), [44:145](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=44-145), [183:957](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-957), [185:2376](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2376), [185:2444](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2444), [183:899](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-899) | `paste/PasteComposer.jsx; paste/NewTreeBirth.jsx` |
| 06 | Switcher/rename/delete, minimap, legend editing | [19:65](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=19-65), [21:65](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=21-65), [23:23](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=23-23), [23:70](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=23-70), [183:1259](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1259) | `identity/TreeSwitcher.jsx; graph/tree/KindLegend.jsx` |
| 07 | Canvas states, selection, connection/reorder/marquee, peer cursor | [36:91](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=36-91), [28:18](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=28-18), [2:20](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=2-20), [13:36](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=13-36), [183:1259](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1259) | `scene/; presence/PresenceLayer.jsx; SkillTreeView.jsx` |
| 08 | Desktop available/complete/locked/rename, annotation, history | [33:105](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=33-105), [183:1099](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1099) | `graph/StepPanel.jsx; activity/EventRow.jsx` |
| 09 | Private note/link/checklist, add/rename inputs | [34:131](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=34-131), [13:3](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=13-3), [183:1099](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1099) | `graph/tree/NodeWorkspace.jsx; graph/tree/Checklist.jsx; graph/tree/useWorkspace.js` |
| 10 | Reader available/locked/complete, relations, demo exception | [34:80](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=34-80), [32:73](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=32-73), [194:1008](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=194-1008) | `graph/StepPanel.jsx; SkillTreeView.jsx` |
| 11 | Tablet panel: Light/Dark, progress variants, name/root | [160:11](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-11), [160:110](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-110), [160:209](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-209), [160:253](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-253), [160:298](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-298), [183:1904](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1904), [183:625](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-625) | `graph/tablet/TabletEditor.jsx; graph/tablet/TabletPanel.jsx` |
| 12 | Tablet connect needs/unlocks, remove-link and bulk modes | [183:561](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-561), [183:625](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-625), [182:348](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=182-348) | `graph/tablet/TabletPanel.jsx; graph/tablet/useTabletEditing.js` |
| 15 | Grouped activity/history | [162:324](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-324), [162:341](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-341), [162:349](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-349), [185:291](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-291), [194:1675](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=194-1675) | `activity/ActivityFeed.jsx; activity/EventRow.jsx; activity/grammar.jsx` |
| 16 | Undo/Restore, ticker, milestone, return recap, cycle/layout failure | [26:473](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=26-473), [26:502](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=26-502), [31:32](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=31-32), [185:394](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-394), [184:1947](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1947) | `SkillTreeView.jsx; model/progress.js; model/milestones.js` |
| 17 | Share private/public/unlisted, visitor/no-ID guards, busy and outcomes | [99:2](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=99-2), [185:1477](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1477), [185:1943](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1943) | `share/ShareDialog.jsx` |
| 18 | Fork signed-in/email, busy/error/session expiry, sent/rate, responsive wrappers | [183:362](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-362), [183:380](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-380), [183:211](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-211), [183:230](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-230), [183:247](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-247), [180:77](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=180-77) | `share/ForkDoor.jsx` |
| 19 | Gallery cards, loading/empty/error/paging, fork lifecycle, responsive grid | [59:10](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=59-10), [61:2](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=61-2), [63:2](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=63-2), [185:1544](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1544), [185:1953](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1953) | `browse/BrowsePage.jsx; browse/BrowseCard.jsx; browse/galleryIndex.js` |
| 20 | Playable demo coach, staged completion/unlock and fork | [64:2](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=64-2), [34:80](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=34-80), [29:38](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=29-38), [180:77](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=180-77) | `demo/demoStage.js; demo/CoachChip.jsx; SkillTreeView.jsx` |
| 21 | Desktop/mobile Tend prompt, working, receipts/detail/Undo and refusals | [185:152](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-152), [185:194](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-194), [28:59](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=28-59), [185:955](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-955), [184:1947](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1947) | `tending/TendBar.jsx; tending/receipts.js; SkillTreeView.jsx` |
| 22 | Export idle/preparing/success/no-tree/failure | [162:283](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-283) | `settings/YourDataSection.jsx; settings/exportArchive.js` |
| 23 | Reminder enabled/off/suppressed, schedule/timezone, save/refusal and absence gates | [162:296](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-296), [184:1307](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1307), [185:1359](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1359) | `settings/ReminderSection.jsx; reminders/remindersClient.js` |
| 24 | AI settings meter, optional PRO, history/empty, absence gates | [162:315](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-315), [184:1307](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1307), [185:1400](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1400), [185:1459](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1459) | `settings/TendingSection.jsx; tending/receipts.js` |
| 25 | Mac/Windows shortcuts, editor/reader and phone subset | [185:2501](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2501), [188:662](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-662) | `shortcuts/ShortcutsDialog.jsx; shortcuts/shortcutMap.js; skilltree.css` |

## Route map and legitimate external owners

| Entry | Current destination and owner |
|---|---|
| `/app/roadmap`, `#/app` | Resolver → remembered/newest tree or QuestShelf; families 01/03/07. Canonical owner room includes Shell. |
| `#/app/start`, `#/app/new`, `#/app/new?compose` | QuestShelf, blank birth, paste; families 03–05. Legacy app hashes upgrade the path to `/app/roadmap`. |
| `#/app/:treeId` | Owner/editor or demoted reader; families 02/06–16/21. |
| `/t/:treeId`, `#/t/:treeId`, legacy `?view` | Shared reader and ForkDoor; families 10/17/18. |
| `#/demo` | Local demo completion and fork; family 20. |
| `#/browse` | Public gallery; family 19. Standalone share/demo/browse may omit Shell; those hashes within `/app/roadmap` retain it. |
| `/app/settings`, `#/settings` | Shell wrapper plus Roadmap export/reminder/AI sections; families 22–24. |
| `/app/connect`, `#/connect`, `#/oauth/authorize`, `#/auth?...` | [Shell](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf) owns Connect, OAuth and magic-link verification. |
| Generic sign-in, account, appearance, sync adoption/sign-out | [Shell](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf) owns these surfaces; the product-specific ForkDoor remains Roadmap-owned. |
| `/roadmap`, `/products/roadmap`, root Roadmap band, `/gallery` information | [Marketing](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81) owns landing, root and information surfaces. |
| `#/showcase` | Developer component gallery; explicitly outside customer-flow coverage. |

Route evidence: `web/src/shell/App.jsx`, `web/src/shell/chrome/Shell.jsx`, Roadmap `routes.js`
and `SkillTreeApp.jsx`. External-owner links are ownership boundaries, not a claim that those files
were exhaustively reconciled during this Roadmap phase.

## Runtime evidence and limits

The source audit used commit `92be064a`; current Roadmap source and styles were checked against the
latest integration base. No production user data, provider keys, email or telemetry credentials
were used. Isolated fixture services and session material were removed after capture.

- `/tmp/windmill-roadmap-reconcile-runtime/manifest.json`: desktop/phone canvas, selection,
  Focus/All steps, signed-in light/dark List and inline detail; desktop rename and Complete→Reset;
  Publish+copy→public, gallery inclusion and Make private. Fixture restored private. Settings/export
  idle captured. The phone completion mutation itself was not exercised.
- `/tmp/windmill-roadmap-reconcile/`: anonymous shelf, blank birth, parsed paste and local tree;
  Figma before/after comparisons. `web-room-{light,dark}.png` are inner-viewport crops; full owner
  Shell was checked against signed runtime captures and route source.
- `/tmp/windmill-roadmap-fork-runtime/evidence.json` and `fork-{desktop,phone,tablet}-open.png`:
  anonymous ForkDoor geometry. Shared-tree desktop 1440 uses a full-width bottom sheet 293px high;
  phone 390 uses a 335px sheet; tablet 834 uses a centered 420×336 dialog. No email was sent.
- `/tmp/windmill-roadmap-shortcuts-runtime/evidence.json`: desktop/phone, owner/reader, Mac/Windows;
  toggles and Escape exercised, no page errors. Narrow/current keycap overlap is preserved and
  recorded in the ledger.

AI Shape/Tend provider outcomes, export completion/errors, reminder delivery, allowance histories,
rare failures and advanced gestures are source-reconciled fixtures, not live integration tests.
Reminder and AI gates were not forced. Conditional states do not promise every account sees them.
Static native graphs approximate WebGL lighting; editable quest thumbnails derive from the current
roster/layout source. Gallery portrait slots are data-dependent payload areas. Still drawings and
SwiftShader/reduced-motion captures do not establish animation timing or hardware performance.

## Visual review and simplification

The read-only acceptance pass checked all 25 families against source. The focused fix pass corrected
conditional paste name fields, locked progress actions, owner/visitor boundaries, mobile deletion
wording, restoration versus AI receipt detail, gallery copy, activity day grouping and selected-node
event fixtures.
Populated history and Activity now share the native EventRow component; fork, mobile action modes,
Shape phases, feedback and Tend input reuse native state families. Superseded shared Shell/Home
copies are owner links. No complete-screen image fills substitute for editable UI.

Representative final evidence in `/tmp/windmill-roadmap-reconcile/`: `figma-night-final.png`,
`figma-list-after.png`, `figma-mobile-owner-final.png`, `figma-mobile-complete-final.png`,
`final-183-1099.png`, `final-45-428.png`, `final-183-625.png`, `final-194-1008.png`,
`figma-web-coverage-final.png`, and `figma-web-mobile-coverage-final.png`. Settings/shortcuts checks
are `/tmp/roadmap-settings-final.png`,
`/tmp/roadmap-settings-mobile-final.png`, `/tmp/roadmap-shortcuts-final.png`,
`/tmp/roadmap-shortcuts-mobile.png`. Layout QA checks text clipping, overlap, theme resolution,
responsive bounds, ownership messaging and source action vocabulary.

## Tracked implementation/design drift

The [consistency ledger](consistency.md#roadmap) retains publication/gallery-copy disagreement,
AI failure prompt-retention copy, mobile empty-tree recovery, narrow shortcuts overlap, the
published input sizing adapter, DOM/canvas fruit treatment and Marketing capability copy.
A current bug can be accurately drawn and marked reconciled; that does not resolve the bug.

[`web/OBSERVABILITY.md`](../../web/OBSERVABILITY.md) tables every Board and Graph step against its
event. Reconciliation is tracked by `roadmap-web-figma-coverage-20261024` in tree `t_9362d9bc883e0a1e`.
