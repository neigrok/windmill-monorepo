# Share a roadmap

Share publishes a roadmap and provides its public link. Opening Share alone must not change
visibility. The owner must choose **Publish and copy link** after reading the disclosure. Private and
unlisted roadmaps follow the same publish flow; sharing does not create an unlisted link.

## Contract and copy

| State | Content | Action |
|---|---|---|
| Owner, not public | **Share roadmap** · “Publishing makes this roadmap public. Anyone can view and fork it, and it can appear in the public gallery.” | **Publish and copy link** · close control |
| Publishing | **Please wait…**; retain the disclosure; a private URL stays hidden | Disable repeat submission |
| Publication unconfirmed | Publication error followed by “Try again.” | Repeat the primary action · **Close** |
| Server confirms public | **Share roadmap** · full-width selectable canonical URL above the button row | **Copy link**; owner also has **Make private** |
| Clipboard succeeds | **Link copied.** | Keep the public link available |
| Clipboard fails | “Could not copy the link. Select the link to copy it manually, or try again.” | **Copy link**; owner also has **Make private** |
| Existing public owner or visitor | **Share roadmap** · “This roadmap is public. Anyone can view and fork it, and it can appear in the public gallery.” · full-width URL above actions | **Copy link**; owner also has **Make private** |

- The publish action must await server-confirmed `visibility: public` before exposing a private roadmap’s link,
  copying it, or announcing publication success. A local visibility update or queued save is not
  confirmation. Never show **Link copied.** until the clipboard promise succeeds.
- A publish error must leave the dialog open and retryable. Retry the idempotent visibility
  PATCH; do not claim the roadmap is private when publication is unknown.
- Publication and copying are separate outcomes. If copying fails after publication, keep the
  confirmed public state and selectable URL; retry only copying.
- Existing public visitors, including signed-out visitors, copy without mutation or an auth gate.
  A visitor must never see an owner's publication or visibility controls.
- Closing before submission leaves visibility unchanged. While busy, disable dismissal and
  repeat submissions. The next submission retries the same idempotent action.
- **Make private** belongs beside the copy action for an owner with a reachable roadmap. Await
  the server before hiding the URL or reporting “Roadmap is private. Only you can view it.”
  On failure retain the reachable state and offer retry.
- Existing unlisted visitors may copy their already-reachable link without mutation. The owner
  still gets **Publish and copy link**; sharing must not create new unlisted roadmaps.
- Publishing makes a roadmap eligible for discovery in the public gallery, subject to its normal
  name and step-count criteria. The disclosure says **can appear**, never guarantees placement.

## Surface and feedback

Use the shared 640px Dialog, constrained to the viewport on mobile web. Keep the disclosure directly
above the primary action. Preserve the roadmap's room tokens, Baloo 2 headings and Nunito body.
The phone's **Share** stays in the action lane with a ≥44px target; keep actions reachable above the
safe area. Use the shared Dialog’s keyboard and focus behavior. Copy success uses `role="status"`;
retryable failures use `role="alert"`.

The dialog uses its existing interaction feedback. No new timed transition or ceremony is part of
this sharing change; server and clipboard promises determine pending and success states.

## Scope

No PNG download/copy, image attachment, video export, client OG capture/upload, week/day segment,
progress-card ledger, or recurring image-sharing offer belongs in this flow. Account data export
is a separate feature. Link-preview delivery is specified in `og-tree-cards.md`; a public link
must remain useful even when its preview is generic or stale.

## Design mapping

Windmill · Roadmap: `HM4d8YWzJZg5clVRJKNuDr`, Public page `59:2`. Share-state board `99:2` sits beside
the gallery boards. Existing entry points are Room `19:27` (desktop) and `28:51` (phone).
The public-gallery empty-state disclosure is `63:9`; portrait delivery is `59:94`.

| State | Node |
|---|---|
| Private owner | `99:83` |
| Public owner, copied | `100:3` |
| Publishing | `100:21` |
| Publish error | `100:32` |
| Public visitor | `100:45` |
| Copy error | `100:62` |

The four-word **Publish and copy link** is the explicit implementation contract and an intentional
text-budget exception. It names both consequences. No new reusable component is required: the
flow composes the shared Dialog, Button and a read-only URL field.
