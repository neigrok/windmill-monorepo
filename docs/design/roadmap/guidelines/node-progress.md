# Roadmap progress and controls

A step has two explicit progress values: **Not started** and **Complete**. Prerequisites derive
the canvas treatment: **Locked**, **Available**, or **Complete**. Legacy `active` and `inProgress`
values normalize to `none`; a reset step follows the same prerequisite rules as every other
unfinished step.

The desktop detail panel shows a static status and one action: **Complete** for an available
step, or **Reset** for a completed step. A locked step explains its prerequisite. There is no
progress selector, Start action, started timestamp, or persistent in-progress animation.
Completing a step keeps the existing completion and unlock feedback; Reset uses a quiet return
to the derived state. Reduced motion uses the shared motion contract.

The panel keeps the editable name, Close, authored content, workspace, real prerequisites,
real history, Kind and Delete. An absent icon has no empty container. Empty prerequisite and
history sections have no headings or explanatory filler. Phone and list views use **Mark done**
and **Mark not done** for the same binary progress behavior, preserving touch and keyboard access.

The canvas toolbar keeps navigation, Ask AI, Next / Activity, Share, Zoom out, Zoom in, Focus and
All steps. The authored-reset button, keyboard-help button and Activity pin are omitted. Keyboard help
opens with `?`; Undo remains available through its shortcut and action receipts. Pointer zoom
controls remain available for people who cannot use pinch or wheel gestures.

Kind color stays independent of progress. Only completed nodes wear the progress halo; selection
and finite unlock feedback remain separate. Component sets offer six kinds by three derived
tiers, with no duplicate unfinished variant.

The [state components](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr/Windmill-Roadmap?node-id=2-125),
[detail panel](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr/Windmill-Roadmap?node-id=33-105)
and [toolbar](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr/Windmill-Roadmap?node-id=19-65)
carry this control set. The DOM / WebGL available-fill disagreement remains tracked in
`../../consistency.md`, entry 1e; the marketing bubble-layout alignment is tracked there in F50.
