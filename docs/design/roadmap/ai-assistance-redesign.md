# Roadmap AI requests — redesign proposal

Status: interaction proposal. The previews are editable Figma designs, not an implemented AI protocol.

## Screens

The **AI requests · Proposal** page in Windmill · Roadmap contains a linked mobile-web sequence:

| State | Drawing |
|---|---|
| Ask AI | [Request](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=105-12) |
| Review changes | [Preview](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=105-13) |
| Applied result | [Updated roadmap](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=105-14) |

## One entry, one understandable request

**Ask AI** is the entry label. An empty roadmap asks what the person wants to build; an existing roadmap asks what should change. Selection supplies scope, visible as the selected step or Whole roadmap. The person can type an ordinary request or use the keyboard's native dictation. No dedicated recording control is needed for roadmap text input.

The canvas remains the main surface. A focused command sheet replaces a permanent chat sidebar. Manual edits remain directly available. Existing create, import and change entry points should converge on the same request and review sequence rather than teaching separate paid units or product-specific quotas.

## Generate, review, apply

Preview changes begins the active AI request and may use credits. The sheet retains the prompt while preparing a proposed command batch. No live nodes change during generation. A generation error keeps the prompt; retry is explicit. Stop interrupts generation, and must report any actual credit use without pretending provider work was free.

Review shows concrete before/after values and the affected scope. The illustration changes one step from three sessions to two; the actual request receipt is illustrated as 0.8 credits. This is example data, not a predicted price or a universal per-request charge. A new revision invokes new AI work and must make that consequence clear. Reviewing, selecting proposed changes, applying a previously generated batch and undoing it do not themselves invoke new AI work or create another AI debit.

Apply changes validates the current roadmap revision, then commits the approved batch as one history operation. The applying state disables duplicate submission and reads Applying changes; there is no fabricated progress percentage. Success changes the matching canvas node and displays one receipt with Undo. A failed apply retains the proposal and exposes retry; it must never claim success before persistence confirms it.

If the roadmap changed after the preview, the service must detect the stale revision and request a fresh review rather than overwrite unseen work. Deletions show invested progress and notes in the review; destructive scope is never hidden among additions. Question-only requests display an answer or findings attached to affected steps, with no Apply button when there is no mutation.

## Credits and passive processing

Only active requests debit customer AI credits. The denomination is shared across roadmap, gym Coach and journal voice; the customer never sees raw model tokens. There is no additional monthly roadmap request-count allowance in this design. Automatic journal echoes remain full, included, always enabled and excluded from customer debits.

The allowance lives in Account, with a quiet credit-use disclosure at request submission and a precise receipt after processing. Exhaustion pauses new AI requests, retains the prompt and names the next available action. It never blocks hand editing or removes existing work. AI availability errors and credit-reporting errors are separate states.

## Motion, reach and semantics

The three concept screens are 402 × 874 mobile-web layouts. Identity stays above the canvas; prompt, review and primary actions occupy the bottom reach band. The action row stays outside scrolling content and clears the safe inset. Keyboard appearance reduces the visible canvas and preserves the prompt and submission action.

A short emphasis highlights the changed node only after Apply succeeds. Keep the camera still while reading the preview; move it only when the person chooses to inspect a different affected step. Reduced motion uses an immediate final state. Announce Preparing preview, Preview ready, Applying changes and Plan updated as status changes without narrating internal tool calls.

The proposed controls use shared Button instances, Roadmap Skill Node instances, semantic colors and shared spacing variables. Existing typography is retained. The file contains a compact request-review-result flow; detailed error, cancellation, selection and desktop adaptations are requirements here, not additional claimed drawings.

## Implementation contract

Separate AI generation from roadmap mutation: request intent and scope; prepare a revision-bound proposal; review; apply atomically; receipt and one undo. Keep provider spend distinct from customer chargeability. The customer activity record needs request identity, product, exact credit debit, status and restoration timing. Background work has no customer debit. Legacy wire identifiers can remain compatibility details without appearing in product language.

This phase does not implement or test those backend guarantees. They are prerequisites for promoting the interaction proposal to the live product.

## Verification and canon reconciliation

All three 402 × 874 proposal screens were rendered and visually inspected. The simplification pass keeps one prompt, one concrete before/after review and one result receipt; shared components provide the node and button vocabulary. Figma links connect Preview changes, Revise, Apply changes and Undo. The applying state is specified in this brief rather than claimed as a fourth drawing. No application guarantees or browser interactions were tested by this design phase.

Bounded existing drawings were reconciled alongside the proposal: the Roadmap Room AI entry labels and annotations; Marketing landing and static-page AI pricing copy; and Journal full-echo reader and access specimens. Four Journal payment sheets are now included echo readers, with the complete passage taken from `web/src/products/journal/echoes/fixtures.js`. The Night echo reader and margin, and the desktop pricing specimen were rendered for visual inspection. This is not a claim that every historical drawing in every file was audited; unrelated frame structures remain untouched.
