# Mood and energy input exploration

Three editable proposals live on [Explore · Mood & energy · Sep 2026](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=176-837). They are alternatives for review, not implemented controls or replacements for the current canon.

| Direction | Proposal | Tradeoff |
|---|---|---|
| [Quiet rails](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=176-838) | Thin labelled scales with generous targets and explicit editing actions | Fastest direct entry; keeps two full rows visible |
| [Fold-away controls](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=176-839) | Compact values open a focused 0–10 picker | Calmest writing surface; adds one opening tap |
| [Number ribbon](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=176-840) | Large exact numbers in a horizontally snapping ribbon | Tactile and distinct; occupies more space and introduces scrolling |

Recommend **Fold-away controls**: opening the relevant field directly keeps the writing surface quiet while exposing all eleven numbers as clear targets. An unanswered field reads “Add mood”; 0 remains visibly recorded. The Energy row switches directly to that field. A number commits immediately; Done only dismisses. This proposes replacing the always-visible two-row strip, so promotion requires updating `journal.md` and `scales.md` together with implementation.

All directions retain independent optional values, every integer from 0 through 10, gold mood, olive energy, and keyboard-up suppression on phone. An untouched picker must remain null after dismissal. Clear removes a recorded value. Motion responds equally to every value; no low-value failure state or high-value celebration is proposed. Boards specify keyboard behavior, focus return, motion, and desktop adaptations.

The exploration reuses the existing Journal color variables and Baloo 2, Nunito, and JetBrains Mono typography. Its shared canvas and input specimens are organized into 15 local components and 21 instances. A read-back audit found no unbound solid fills. Screenshots were inspected for the three directions and the [day-theme picker](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=183-303). The simplification pass fixed clipped endpoint labels, removed the unset ribbon’s Clear label and duplicate zero endpoint, and extracted editable component sources. Existing canonical boards remain unchanged.

These are static annotated designs. Gesture behavior, haptics, keyboard handling, screen-reader announcements, contrast across every mood value, and persistence need verification in an implementation. Before promotion, test whether the extra tap in Fold-away controls materially reduces use, confirm focus/caret preservation, and verify 44 px action targets and null-versus-zero behavior on supported phone widths. Current phone proposals are 390 px wide; desktop adaptations are annotated rather than complete desktop screens.
