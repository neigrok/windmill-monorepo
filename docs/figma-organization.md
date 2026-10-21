# Figma organization

The [design index](design/readme.md) lists the six working files. Shared application navigation,
account and onboarding belong to Shell; product screens belong to their product files. The Design
System owns reusable foundations and published components.

The Design System file is in the Library project. Roadmap, Journal, Shell and Gym are in Products.
The Marketing file is in Marketing. Sandbox is empty and available for exploratory work.
The approved-logo source file remains in Team project, outside the six working files.

Shell's iOS page contains the shared first-run journey, including its Journal boards. Standalone
Echoes boards live on Journal's iOS page.

Shell has Cover, Model, Components, Web, iOS, Android and Proposals pages. A platform is a page
within its owner, not a separate product file. Proposals remain separate from delivery screens.

| Owner | Pages |
|---|---|
| Roadmap | Cover, Model, Components, Web, Proposals |
| Journal | Cover, Model, Components, Web, iOS, Proposals |
| Gym | Cover, Model, Components, Web, iOS, Android, Proposals |
| Marketing | Landings, Static pages, Emails, Store listings |

Journal's Model page and Marketing's Store listings page are empty. Gym's retired
Today/Ask drawings sit in the [Boards archive](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1084-15663).
Gym's iOS page is organized as one section per user flow (see [the flow index](index.md)).
The organization check does not establish visual acceptance of the screens.
Superseded boards are deleted, not archived.

The library has three variable collections: Brand (Roadmap, Journal, Gym), Theme (Light, Dark),
and Scale (one Value mode). Theme colour values alias Brand. Theme `ios/*` roles hold iOS
colours; Android uses shared roles with the room's Brand mode. Theme `illustration/*` roles hold
product glimpses. Scale `ios/font/*` roles hold the editable font stand-ins. Product-only colours and metrics remain in their product files.

## Verification

The binding audit and the three-product Light/Dark Button renders passed. Fresh remote imports
in Roadmap resolve the final published Brand, Theme and native component bindings. Shared Buttons
inherit the room's Brand and the containing surface's Theme without instance mode overrides.

## Structural observations

- A cross-file move changes node IDs. Written citations need a verified destination map; matching
  titles alone does not establish that a board and its descendants survived the move.
- Moving screens does not resolve component bindings, typography or copy disagreements. Those
  remain in the [consistency ledger](design/consistency.md) until separately verified.
- Source-page wrappers preserve explicit appearance modes and existing board IDs during moves
  within a file. Empty source pages can be removed after their descendants are accounted for.
