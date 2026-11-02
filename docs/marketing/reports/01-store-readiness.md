# 01 · Store access and release readiness

Kind: build · Stage: 0 · Window: Nov 2 to Dec 20, 2026 · Cash: $0 to $150 · CEO hours / agent days: 4h / 4d

## Idea
Put Windmill on the App Store and Google Play. Today iOS ships through TestFlight only and Android by
sideload only, so no creator, listing or search action has anywhere to send a person. The
deliverables are two production listings, installable by anyone, with store badges on the web.

## Pros
- Removes the one blocker every other action shares.
- Creator links, custom product pages and attribution need a store page to point at.
- Production installs feed the store conversion and activation views in report 02.
- Both listings exist before Q5, when Health & Fitness demand peaks.

## Cons
- App Review timing is outside our control and a rejection costs a cycle.
- A personal Google Play account must run a closed test with 12 testers for 14 consecutive days before it can apply for production access.
- Store screenshots and listing copy need approved Figma designs first.
- Fees for developer accounts may apply if either account is not already in place.

## Estimates
| Item | Estimate |
|---|---|
| Cash | $0 to $150 in account and listing fees (assumption: accounts already exist) |
| Effort | 4 CEO hours for account checks and submissions; 4 agent days for assets, metadata and release builds |
| Outcome | both stores live by Dec 1, 2026, with Dec 20 as the last acceptable date |

## Success metric
Both native stores are live and installable by the public by Dec 20, 2026.

## Failure metric
Either store is unavailable on Dec 20, 2026. The creator campaign in report 09 then sends traffic only
to the platform that is live, and the missing platform's share of the Q5 budget is held back.

## Justification
The agreed calendar points every launch-shaped action at Dec 26 to Jan 15, when US Health & Fitness
downloads run more than 20% above the yearly average (Sensor Tower, 2025). A 34-app study found no
launch boost on the App Store in 2026, so there is no reason to wait for a bigger moment, and every
reason to have stable listings well before the campaign. A listing per existing binary with a
Gym-led default keeps evidence from fragmenting across pages. The alternative, driving traffic to
TestFlight and sideloads, throws away most installs and all store attribution.

## Dependencies
- CEO verifies the Google Play account type and the Apple developer account state on Nov 2, 2026, and starts the closed test immediately if the account is personal.
- Store screenshots and listing copy approved in Figma before an agent implements them (report 05 owns the assets).
- Release builds through `ios-release.yml` and the Android release pipeline.

## Decision log

| Date | Decision | Numbers |
|---|---|---|
