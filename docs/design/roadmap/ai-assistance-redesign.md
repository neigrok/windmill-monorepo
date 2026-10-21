# Roadmap AI requests — redesign proposal

Status: interaction proposal. The previews are editable Figma designs, not an implemented AI protocol. Their credit fixtures need USD updates; the written allowance policy below is current. The USD backend is off by default and customer rollout remains blocked as described in [AI usage review](../../AI_USAGE_REVIEW.md).

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

Preview changes begins the AI request and may use USD allowance. The sheet retains the prompt while preparing a proposed command batch. No live nodes change during generation. A generation error keeps the prompt; retry is explicit. Stop interrupts generation, and must report actual AI cost and unresolved reservations without pretending provider work was free.

Review shows concrete before/after values and the affected scope. The illustration changes one step from three sessions to two. The receipt must show the server's actual USD use; a fixture cannot predict a price or promise a universal per-request charge. A new revision invokes new AI work and must make that consequence clear. Reviewing, selecting proposed changes, applying a previously generated batch and undoing it do not themselves invoke new AI work or create another AI debit.

Apply changes validates the current roadmap revision, then commits the approved batch as one history operation. The applying state disables duplicate submission and reads Applying changes; there is no fabricated progress percentage. Success changes the matching canvas node and displays one receipt with Undo. A failed apply retains the proposal and exposes retry; it must never claim success before persistence confirms it.

If the roadmap changed after the preview, the service must detect the stale revision and request a fresh review rather than overwrite unseen work. Deletions show invested progress and notes in the review; destructive scope is never hidden among additions. Question-only requests display an answer or findings attached to affected steps, with no Apply button when there is no mutation.

## USD allowance and background processing

Every hosted AI call debits the individual USD allowance, including background Journal processing. The allowance is shared across products; raw model tokens are not the customer unit. There is no additional monthly roadmap request-count allowance in the enabled USD design. Reading existing Echoes incurs no new AI cost; creating new ones needs available allowance and may wait.

The allowance lives in Account, with a quiet USD-use disclosure at request submission and a precise receipt after processing. The [pricing contract](../marketing/guidelines/pricing.md) defines lifetime, calendar-month and funded billing-period allowances. Exhaustion pauses new AI work, retains the prompt and names the supported recovery. It never blocks hand editing or removes existing work. Individual exhaustion, a request too large for its remaining balance, shared free capacity, concurrency and accounting failures are distinct states.

## Motion, reach and semantics

The three concept screens are 402 × 874 mobile-web layouts. Identity stays above the canvas; prompt, review and primary actions occupy the bottom reach band. The action row stays outside scrolling content and clears the safe inset. Keyboard appearance reduces the visible canvas and preserves the prompt and submission action.

A short emphasis highlights the changed node only after Apply succeeds. Keep the camera still while reading the preview; move it only when the person chooses to inspect a different affected step. Reduced motion uses an immediate final state. Announce Preparing preview, Preview ready, Applying changes and Plan updated as status changes without narrating internal tool calls.

The proposed controls use shared Button instances, Roadmap Skill Node instances, semantic colors and shared spacing variables. Existing typography is retained. The file contains a compact request-review-result flow; detailed error, cancellation, selection and desktop adaptations are requirements here, not additional claimed drawings.

## Implementation contract

Separate AI generation from roadmap mutation: request intent and scope; prepare a revision-bound proposal; review; apply atomically; receipt and one undo. The customer activity record needs request identity, product, exact USD cost, held amount, status and the applicable period. Background work uses the same individual allowance. Never display an uncertain reservation as refunded or promise that a period boundary releases it.

These backend guarantees are prerequisites for promoting the interaction proposal to the live product.
