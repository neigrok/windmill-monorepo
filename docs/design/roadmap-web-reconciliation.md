# Roadmap web reconciliation

Current evidence: 2026-10-23–24. Canonical drawings are in
[Roadmap · Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=130-2) and
[Roadmap · Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-2).
Web contains 31 boards in seven sections; Web Mobile contains 19 boards in seven sections. The
[flow index](../index.md#roadmap--web) links nine flow numbers across both pages, totaling 50 boards.
Existing mobile boards retain their IDs and statuses on Web Mobile; complete screens are not duplicated.
Product components live on Components; AI review proposals live on Proposals. Shared account and
settings ownership remains in Shell. Marketing owns landing pages.

## Status and scope

The two 🚀 compositions are [phone List](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=20-2)
and the [dark owner room](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=36-91).
Their geometry and UI content were compared with local runtime captures. This does not verify a
remote deployment. Other boards remain 🚧: they include source-reviewed specimens, conditional
states, and newly compared detail compositions whose full flow is not verified. No ✅ approval was
granted. Native graph shapes are editable approximations of WebGL lighting, not renderer output.

The current model has locked, available and complete states. Only populated phone trees offer
Tree/List; owner phone entry defaults to List, visitor entry to Tree, and new/empty trees to Tree.
Desktop and tablet stay on canvas. Owner phone and tablet editing is supported; the canvas gesture
read-only flag is not an ownership limitation. Phone, tablet and desktop boundaries are 744px and
1024px. Source: `persistence/ViewPrefs.js`, `ui/viewport.js`, `SkillTreeView.jsx`.

Canonical owner routes resolve under `/app/roadmap` and include shared Shell navigation. Standalone
visitor, browse and demo routes may omit Shell. Source: `web/src/shell/App.jsx`,
`web/src/shell/chrome/Shell.jsx`, `web/src/products/roadmap/routes.js`.

## Evidence by journey

Paths below are relative to `web/src/products/roadmap/` unless otherwise stated.

| Journey | Source | Runtime evidence and limits |
|---|---|---|
| Start | `quests/QuestShelf.jsx`, `ui/NewTreeBirth.jsx`, `paste/PasteComposer.jsx` | Anonymous quest shelf, blank birth, parsed paste and local tree creation captured. Failure and AI-shaping states are source-reviewed. |
| List | `list/ListView.jsx`, `list/ViewPill.jsx`, `persistence/ViewPrefs.js` | Anonymous owner List and signed-in light/dark List and expanded step captured. Search, need picker, gestures and filtered-empty specimens are source-reviewed. |
| Tree | `SkillTreeView.jsx`, `ui/ControlBar.jsx`, `ui/TreeSwitcher.jsx`, `ui/tree/KindLegend.jsx`, `theme.js` | Desktop and phone canvas, selection, Focus and All steps captured. Minimap and canonical Shell context compared. Empty/error/visitor specimens are source-reviewed. |
| Detail | `ui/StepPanel.jsx`, `ui/mobile/MobileEditorSheet.jsx` | Desktop rename, available detail, Complete→Reset and phone selected-sheet content captured. Mobile complete/locked variants, tablet panel and advanced editing remain source-reviewed. |
| Progress | `ui/NextUp.jsx`, `activity/ActivityFeed.jsx` | Completion interaction exercised. Next-up/blocked/fully-grown, live feed, undo ticker and return recap are source-reviewed. Ceremonies and timing are not established by still images. |
| Sharing | `share/ShareDialog.jsx`, `ui/mobile/ForkDoor.jsx`, `browse/BrowsePage.jsx` | Publish and copy→public, gallery inclusion and Make private exercised; fixture restored private. Fork/auth/error states are source-reviewed. Gallery empty-copy contradiction remains in the ledger. |
| Settings | `settings/ReminderSection.jsx`, `settings/TendingSection.jsx`, `settings/YourDataSection.jsx` | Settings and export idle captured. Reminder/AI gates disabled locally; enabled, suppression, failure and allowance states are source-reviewed. Export completion/errors were not exercised. No Plan/checkout section is registered. |
| AI | `tending/TendBar.jsx`, `tending/receipts.js`, `paste/PasteComposer.jsx` | Source-reviewed only. AI eligibility applies to the request input, not to the phone Tree/List and owner Share doors. The separate Review/Apply journey is a proposal. |

## Editable drawings and visual checks

The [mobile owner editor](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=158-121)
has Available, Complete and Locked variants, used by the
[phone editing journey](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=170-10).
Its title, authored link, actions, kind palette and prerequisites are native editable layers.
The [desktop inspector](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=33-105)
uses the signed-in fixture and published Button. Settings specimens reuse published Button and Switch.
Paints use existing semantic and Roadmap variables; ticker object text follows `--neutral-0`, and
night toast/ticker shadows use black. Diagram lighting is an explicit static approximation.

Screenshots were checked for text clipping, overlap, theme resolution, ownership messaging and
desktop/phone action differences. The source/status review separately checked AI eligibility,
visitor local-save messaging, gallery controls and empty-tree scope. Both current owner compositions
include Shell; inner inspector/composer/visitor specimens identify their scope.

Local design evidence is in `/tmp/windmill-roadmap-reconcile/`:

| Drawing | Before | Current check |
|---|---|---|
| Dark room, `36:91` | `figma-night-before.png` | `figma-night-final.png` |
| Phone List, `20:2` | `figma-list-before.png` | `figma-list-after.png` |
| Desktop inspector, `33:105` | `figma-desktop-detail-before.png` | `figma-desktop-detail-final.png` |
| Phone owner, `160:11` | — | `figma-mobile-owner-final.png` |
| Complete sheet, `160:253` | — | `figma-mobile-complete-final.png` |
| Visitor chrome, `29:38` | — | `figma-visitor-final.png` |
| Settings, `162:282` | — | `figma-reminders-final.png`, `figma-export-final.png` |
| Phone composer, `44:145` | — | `figma-composer-phone-final.png` |
| Web page, `130:2` | — | `figma-web-overview.png` |
| Web Mobile page, `170:2` | — | `figma-web-mobile-overview.png` |
| Cover navigation, `3:2` | — | `figma-cover-final.png` |

Runtime evidence is in `/tmp/windmill-roadmap-reconcile-runtime/manifest.json` and its screenshot
paths: `desktop/{overview,selected,allsteps}.png`, `phone/{overview,selected,allsteps}.png`,
`desktop-day-{tree,step,rename,complete,share-private,share-public,share-restored,gallery,settings,settings-full}.png`,
and `phone-{light,dark}-{list,step}.png`. Anonymous captures are in the design-evidence folder as
`web-start.png`, `web-birth.png`, `web-compose-ready.png`, `web-room-{light,dark}.png` and
`web-phone-default.png`. The `web-room-*` images are inner-viewport crops; full-room chrome was
verified against the signed runtime captures and route source.

Runtime used an isolated database and synthetic account/tree, without provider, email or telemetry
credentials. Captures use SwiftShader and reduced motion; no real-GPU or animation-performance
claim follows. Session material is excluded from documentation and artifacts.

## Remaining work

The [consistency ledger](consistency.md#roadmap) retains the DOM/canvas available-node treatment,
locked fruit readability, input/review decisions, gallery/marketing copy and mobile empty-state gap.
The default near-black appearance is represented by current Web compositions. Superseded palette
alternatives are absent; the explicit AI review proposal remains separate from implemented flows.

Product event coverage for progress and visibility writes is tracked by dogfood node
`roadmap-web-progress-share-events`. This design phase does not claim those events arrive. The phase
itself is tracked by `roadmap-web-figma-reconcile-20261023` in tree `t_9362d9bc883e0a1e`.

The main structural improvement is one flow index, one mobile editor variant set and one current
night-room composition. Future verification should promote individual source-reviewed states only
after exercising them, preserving the distinction between shipped behavior, a specimen and a proposal.
