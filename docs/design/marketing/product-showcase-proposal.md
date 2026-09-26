# Product showcase proposal

The editable proposal lives on [Three rooms · Product showcase · 2026-09-10](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=187-2). It is a Figma design proposal, not the deployed landing.

| Composition | Frame |
|---|---|
| Desktop, 1440 × 4404px | [One scrolling page](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=187-3) |
| Mobile, 390 × 4522px | [One scrolling page](https://www.figma.com/design/uWLMdVmzTcobOh8hbeem81?node-id=187-4) |

The page has a three-column product introduction followed by a dedicated Roadmap, Journal and Gym showcase. Mobile stacks the introduction and gives each product a composition sized for the narrow viewport. The product canvases carry the explanation; the surrounding copy names the intent and action.

## Product evidence

- Roadmap uses the `learnToSail.js` starter: 17 nodes with radial dependencies. Its root is Rig the boat; Learn to sail is the tree title. Weather is sky, safety is brick, knots are olive and harbor is gold. Progress retains each node's kind hue.
- Journal uses a writing canvas with mood and energy. The desktop composition includes an Echo from an earlier page. The native phone composition shows writing and the two scales; it does not present web-only search or Echoes as native features.
- Gym's large set logger is inside a phone. The web companion is a workout history or routine surface. Use the current Instrument and Daylight palettes; do not portray native logging as a web feature.
- Baloo 2 is display, Nunito is body and UI, and JetBrains Mono is numeric metadata. Product colors come from `web/src/styles/tokens/palettes.css` and `colors.css`.

## Design observations

Large app previews need their own clipped viewport. Marketing headings and actions require reserved space and must remain above any overlapping preview. The mobile composition must be rebuilt around legible product details instead of scaling down a full desktop screen.

The source app canvases are reusable components. Keeping their content separate from the surrounding landing composition allows a fixture, color or screen correction to update every showcase instance.

The mobile Roadmap uses seven readable nodes from the same sailing fixture and a selected-step sheet. The desktop shows the complete 17-node tree with six completed steps. The native Gym fixture has two completed sets at 60 kg × 8, the third set prepared at 62.5 kg × 8, and four sets planned. No live aggregate is inferred from unlogged sets.

## Status

These are static Figma compositions and representative prototype links. Product interaction,
responsive behavior and real data need implementation acceptance.

Tracking: dogfood node `landing-product-showcase-redesign-20260910`.
