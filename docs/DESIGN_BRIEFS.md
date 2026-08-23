# Design canon — known gaps

The written canon is `docs/design/` (start at its `readme.md`); the drawn canon is the five Figma
files. This file lists where the canon and the repo are known to disagree, and the design decisions
still owed. It is not a complete list — verify anything else against the code.

## Canon that contradicts the repo

- **Settings sections.** `roadmap/guidelines/auth.md` §5 draws four sections — Profile, Connected
  tools, Sessions & devices, Your data. `SettingsPage.jsx` also renders Appearance, API keys and
  Feedback, plus roadmap's Reminder and Tending sections. Canon owes those a layout.

## Decisions owed

- **Type and mark.** Baloo 2 / Nunito / JetBrains Mono are declared Google-Fonts stand-ins and no
  logo file exists — every mark is the Baloo wordmark. Either supply licensed fonts plus a mark, or
  bless the stand-ins and the wordmark-only lockup as the brand.
