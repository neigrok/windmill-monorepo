# Design canon — known gaps

The written canon is `docs/design/` (start at its `readme.md`); the drawn canon is the five product
and library Figma files plus the approved logo source in `design/brand-logo.md`. This file lists
where the canon and the repo are known to disagree, and the design decisions still owed. It is not
a complete list — verify anything else against the code.

## Canon that contradicts the repo

- **Settings sections.** `roadmap/guidelines/auth.md` §5 draws four sections — Profile, Connected
  tools, Sessions & devices, Your data. `SettingsPage.jsx` also renders Appearance, API keys and
  Feedback, plus roadmap's Reminder and AI assistance sections. Canon owes those a layout.

## Decisions owed

- **UI type.** Baloo 2 / Nunito / JetBrains Mono are declared Google-Fonts stand-ins. Confirm those
  as the lasting UI families or supply replacement brand fonts. The approved logo's Baloo 2 Bold
  wordmark is fixed in its outlined SVG and does not depend on that decision.
- **Native icons.** Apply the approved windmill mark to the native iOS and Android icon systems;
  review platform masks, small sizes, and supported appearance variants. Scope is in
  `design/brand-logo.md`.
