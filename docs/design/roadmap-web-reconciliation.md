# Roadmap web reconciliation

Retained delivery specimens live on separate
[Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=130-2) and
[Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-2) pages.
The [flow index](../index.md#approved-shared-step-editor) identifies the approved implementation targets;
this map connects retained specimens to deployed source, not an exhaustive set of current designs.

## Status and ownership

🚀 In production identifies delivered flows; 🔨 identifies approved work in development. Only the owner
sets ✅ Ready for dev. 🧩 identifies reusable components and owner links. Superseded development targets
retain their recorded status as context without authorizing their old layout for new work.

List drawings, old phone sheets and tabbed step layouts are marked superseded. The shared read document
from 18/19/27/40 is delivered, including completion, private workspace, history, relationships and deletion.
Inline editing and creation from 19/20 remain separate implementation targets; the document retains nested editors.
The deployed Tend interface is superseded as a target by the right-side Coach, whose functionality is deferred.
Link-copy proposals 15.01–15.02 and 25.01–25.02 point to the implemented recovery in approved 37.01–37.15.

Web and Web Mobile are separate. Product primitives live on Components; helper-local settings and
shortcut primitives remain beside their variants. Shared Shell/Home drawings are thin links to their
canonical owner, avoiding competing copies. Numbered flow sections and the [thin index](../index.md#roadmap--web)
provide navigation.

The model is locked/available/complete. Bubble is the default layout. Owners default to the Board on
every band and visitors to the Graph; birth trees open on the Graph, and an owner's empty tree on the
Board. Phone is below 744px, tablet 744–1023px, desktop 1024px and up. Ordinary step activation opens the
shared document. The 320px tablet panel and 360px desktop inspector remain for Graph naming and tools.
The document's right-side Coach placeholder is 56px collapsed, or 280/340/400px expanded across tablet,
1024–1439px and 1440px-up widths. No checkout or plan section is offered: the web holds none.

## Reference family map

Paths are relative to `web/src/products/roadmap/`. An exact node can be a complete screen, an overlay,
or a reusable state specimen. Repeated server-error strings share their named component faces.
No-render branches are documented as gates rather than invented screens.

| ID | Deployed family / retained specimen | Figma nodes | Source |
|---|---|---|---|
| 01 | Resolution, load/error, desktop empty, HomeCard | [35:24](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=35-24), [41:31](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=41-31), [36:91](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=36-91) | `SkillTreeApp.jsx; SkillTreeView.jsx; HomeCard.jsx` |
| 02 | Local/synced/lapsed, capacity/refused save, ownership demotion | [47:49](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=47-49) | `room/HonestyChrome.jsx; SkillTreeView.jsx` |
| 03 | Quest roster, phone shelf, split start, planting/failure | [45:428](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=45-428), [184:797](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-797), [184:1237](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1237) | `quests/QuestShelf.jsx; quests/QuestThumb.jsx` |
| 04 | Blank birth, name, planting/failure, paste/file drop | [42:37](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=42-37), [42:61](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=42-61), [184:1237](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1237) | `paste/NewTreeBirth.jsx` |
| 05 | Paste/append, parsing/legend, optional name, ghost | [44:71](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=44-71), [44:145](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=44-145), [183:957](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-957), [185:2376](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2376), [185:2444](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2444), [183:899](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-899) | `paste/PasteComposer.jsx; paste/NewTreeBirth.jsx` |
| 06 | Switcher/rename/delete, minimap, legend editing | [19:65](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=19-65), [21:65](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=21-65), [23:23](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=23-23), [23:70](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=23-70), [183:1259](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1259) | `identity/TreeSwitcher.jsx; graph/tree/KindLegend.jsx` |
| 07 | Canvas states, selection, connection/reorder/marquee, peer cursor | [36:91](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=36-91), [28:18](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=28-18), [2:20](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=2-20), [13:36](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=13-36), [183:1259](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1259) | `scene/; presence/PresenceLayer.jsx; SkillTreeView.jsx` |
| 08 | Desktop shared document; retained superseded inspector specimens | [33:105](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=33-105), [183:1099](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1099) | `step/StepDetail.jsx; step/read.css; activity/EventRow.jsx` |
| 09 | Private note/link/subtasks, add/rename inputs | [34:131](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=34-131), [13:3](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=13-3), [183:1099](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1099) | `step/StepWorkspace.jsx; graph/tree/useWorkspace.js` |
| 10 | Reader shared document; retained superseded panel specimens | [34:80](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=34-80), [32:73](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=32-73), [194:1008](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=194-1008) | `step/StepDetail.jsx; SkillTreeView.jsx` |
| 11 | Retained superseded tablet detail; naming/tools panel remains | [160:11](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-11), [160:110](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-110), [160:209](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-209), [160:253](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-253), [160:298](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=160-298), [183:1904](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1904), [183:625](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-625) | `step/StepDetail.jsx; graph/tablet/TabletEditor.jsx; graph/tablet/TabletPanel.jsx` |
| 12 | Tablet connect needs/unlocks, remove-link and bulk modes | [183:561](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-561), [183:625](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-625), [182:348](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=182-348) | `graph/tablet/TabletPanel.jsx; graph/tablet/useTabletEditing.js` |
| 15 | Grouped activity/history | [162:324](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-324), [162:341](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-341), [162:349](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-349), [185:291](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-291), [194:1675](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=194-1675) | `activity/ActivityFeed.jsx; activity/EventRow.jsx; activity/grammar.jsx` |
| 16 | Undo/Restore, ticker, milestone, return recap, cycle/layout failure | [26:473](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=26-473), [26:502](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=26-502), [31:32](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=31-32), [185:394](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-394), [184:1947](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1947) | `SkillTreeView.jsx; model/progress.js; model/milestones.js` |
| 17 | Share private/public, visitor/no-ID guards, busy and outcomes | [99:2](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=99-2), [185:1477](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1477), [185:1943](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1943) | `share/ShareDialog.jsx` |
| 18 | Fork signed-in/email, busy/error/session expiry, sent/rate, responsive wrappers | [183:362](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-362), [183:380](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-380), [183:211](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-211), [183:230](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-230), [183:247](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-247), [180:77](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=180-77) | `share/ForkDoor.jsx` |
| 19 | Gallery cards, loading/empty/error/paging, fork lifecycle, responsive grid | [59:10](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=59-10), [61:2](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=61-2), [63:2](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=63-2), [185:1544](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1544), [185:1953](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1953) | `browse/BrowsePage.jsx; browse/BrowseCard.jsx; browse/galleryIndex.js` |
| 20 | Playable demo coach, staged completion/unlock and fork | [64:2](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=64-2), [34:80](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=34-80), [29:38](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=29-38), [180:77](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=180-77) | `demo/demoStage.js; demo/CoachChip.jsx; SkillTreeView.jsx` |
| 21 | Desktop/mobile Tend prompt, working, receipts/detail/Undo and refusals | [185:152](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-152), [185:194](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-194), [28:59](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=28-59), [185:955](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-955), [184:1947](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1947) | `tending/TendBar.jsx; tending/receipts.js; SkillTreeView.jsx` |
| 22 | Export idle/preparing/success/no-tree/failure | [162:283](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-283) | `settings/YourDataSection.jsx; settings/exportArchive.js` |
| 23 | Reminder enabled/off/suppressed, schedule/timezone, save/refusal and absence gates | [162:296](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-296), [184:1307](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1307), [185:1359](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1359) | `settings/ReminderSection.jsx; reminders/remindersClient.js` |
| 24 | AI settings meter, optional PRO, history/empty, absence gates | [162:315](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=162-315), [184:1307](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1307), [185:1400](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1400), [185:1459](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1459) | `settings/TendingSection.jsx; tending/receipts.js` |
| 25 | Graph Mac/Windows and Board shortcuts, editor/reader and phone subset | [12.01–12.16](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1109-534) | `shortcuts/ShortcutsDialog.jsx; shortcuts/shortcutMap.js; skilltree.css` |
| 26 | Shared nonmodal read document, owner/reader, inline Workspace/History and Coach placeholder | [19.01](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=756-53402), [27.02–27.03](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=756-53413), [40](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1156-79681) | `step/StepDetail.jsx; step/StepWorkspace.jsx; step/read.css; SkillTreeView.jsx` |
| 27 | Refused sync recovery inside the document | [43](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1211-104922) | `step/StepDetail.jsx; sync/SyncNotices.jsx; room/useRoomProgress.js` |
| 28 | Step-link clipboard failure, selectable address, retry and focus return | [37](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1116-74911) | `step/StepDetail.jsx; step/read.css` |

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

## Evidence and remaining work

The [Roadmap alignment subtree](https://windmill.works/#/app/t_63c2c557d482dece) records current
implementation, review, runtime and deployment evidence for each delivery. The
[consistency ledger](consistency.md#roadmap) records unresolved design and implementation differences.
A retained drawing does not establish that every conditional branch has been exercised.

Still drawings and SwiftShader/reduced-motion captures cannot establish hardware animation performance.
[`web/OBSERVABILITY.md`](../../web/OBSERVABILITY.md) lists the events and failure reporting for Board and Graph flows.
