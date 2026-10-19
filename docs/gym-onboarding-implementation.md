# Gym Coach onboarding

This phase covers the shared Coach contract and signed-in iOS setup. Anonymous Coach, device
attestation, account adoption, Android onboarding and customer Usage screens remain separate work.

## Design sources

The iOS flow uses the existing Coach room, Routines destination and workout logger.

| State | Figma |
| --- | --- |
| Signed-in first open | [143:1390](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=143-1390) |
| Goal clarification | [147:2095](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=147-2095) |
| Created routines | [146:1937](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=146-1937) |
| Program result | [148:2224](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=148-2224) |
| Routine to workout | [147:1975](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=147-1975) |

The program-result frame's “Only on this phone” and “Keep it” belong to anonymous use and are not
part of signed-in setup. Screenshots are user attachments, not bundled illustrations. Starter
symbols are `photo.on.rectangle`, `text.alignleft` and `target`; creation receipts use
`checkmark.circle` and `arrow.up.right`, confirmed from their Figma component identities.

## Structure

- GymRoom owns destination selection and the existing manual logging and routine-editor routes.
- CoachTab owns first-use composition, existing attachment/composer controls, conversation rendering
  and navigation from results. It uses the room's existing palette, type and navigation components.
- CoachConversation owns the account-scoped persisted draft and explicit sending. Selecting a
  starter or clarification option changes a draft; it does not invoke the model.
- The backend owns bounded clarification data, creation identities and factual receipts. Existing
  routine changes retain Review and Apply. Clients do not infer actions from generated prose.

Automatic setup requires loaded account data and an empty Gym account. Active workouts, account
changes, data adoption and a saved conversation or draft take precedence. A deliberate manual route
is remembered for that account. Empty Routines retains a quiet setup action without repeatedly redirecting the
person.

## Verification

High-fidelity Figma contexts and screenshots for all five states have been inspected. The target
uses GymPalette and ShellType rather than a parallel token collection. Native hit targets remain
44 pt even where the drawing's chip capsule is 36 pt; text and rows grow at accessibility sizes.

All nine backend suites pass. Local HTTP verification against the running backend and PostgreSQL
passed clarification/history, immutable request purpose, owner isolation, two persisted routines
after an interrupted answer,
retry with different model tool IDs, completed replay without provider dispatch, USD refusal
without dispatch, the 8,000-byte bound and all eight setup-event actions at the event intake. The
provider was a controlled local fixture; this does not establish live-model response quality.
Local telemetry delivery and privacy checks pass. The existing web client loads the new receipts
and routines; its inaccurate capability subtitle remains recorded in the consistency ledger.

All 106 native tests and 15 distinct targeted UI cases pass, including result-to-routine-to-workout,
relaunch, manual exits and the empty-Routines setup action. Light and dark entry, dark goal and
creation results match the requested content hierarchy and grouped actions. At Accessibility XXXL,
starter symbols and labels remain separate, selected long choices remain reachable, and the editable
composer preserves the full draft while showing at most two lines. Send and jump symbols fit their
controls. The final multiline choice screenshot and targeted UI test pass: an 18 pt corner radius
keeps wrapped text inside the outline while preserving the default 36 pt pill shape.

Ten focused Gym UI regression cases pass locally, covering account adoption, light/dark log charts,
routine building, workout ledger details, offline restoration, Live Activity and Control Center.

Conversation and provider responses use controlled fixtures. Real photo selection, upload retry,
authenticated image reads and live-model behavior require separate evidence.

## Structure observations

Keep setup beside the Coach conversation instead of introducing a separate onboarding coordinator.
Keep presentation-only prompt choices in the Coach contract, not the routine or sync domain. Reuse
one receipt row shape for one or several creations. Keep entry preference account-scoped and
separate from content so deleting a routine cannot silently reset the person's navigation choice.

UI tests use surviving chart points and target semantic row elements. The shared workout-ledger
helper traverses virtualized lists while asserting exact saved-set identifiers, values and counts.

Existing native composer and toolbar differences from the first-run drawings remain recorded in
the [consistency ledger](design/consistency.md); this phase does not redefine room chrome.
