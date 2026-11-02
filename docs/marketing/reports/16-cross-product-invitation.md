# 16 · The cross-product invitation experiment

Kind: experiment · Stage: 1 to 2 · Window: no earlier than Feb 20, 2027; read by day 60 after the first invitation · Cash: $0 to $100 · CEO hours / agent days: 2h / 2d

## Idea

Established users of one product receive one relevant invitation to try a second, for example a
lifter who has logged for four weeks is shown Roadmap once as a place to plan a training block.
Half of the eligible users, chosen at random, receive no invitation. One invitation, no banners, no
repeat nudges, and nothing counts declines. The experiment occupies one of the two experiment slots.

## Pros

- Tests the superapp's value argument with a causal read instead of a correlation.
- One account and one allowance may raise the value of One for people who use two products.
- Cheap: a single surface and the existing activation views.
- Honest by construction.

## Cons

- Distracts an engaged user from the product that earned their trust.
- Cross-product correlation is misleading without the holdout, and 100 invitations are small.
- A second product can lower primary-product retention.
- Any revenue claim needs a larger sample than this test has.

## Estimates

| Item | Number | Basis |
|---|---|---|
| Cash | $0 to $100 | |
| Effort | 2 CEO hours, 2 agent days | design approval and build |
| Invitations | 100, with a randomised no-invitation group | assumption on size |
| Second-product activations | about 10, 2 to 4 buyers | assumption |

## Success metric

At least 10% second-product activation across 100 invitations, with no observed primary-product
retention decline versus the holdout.

## Failure metric

Under 5% activation, or a primary-product retention drop versus the holdout by day 60. On failure
the invitation is removed and the superapp stays a settings-level fact rather than a prompt.

## Justification

The superapp is a second-order argument in strategy.md: one job per landing, and the three-tool
story only after one product has earned trust. This test is the first honest way to learn whether
the second tool adds value or noise. It is scheduled after the Q5 results so an experiment slot is
free and the eligible population exists. The brand canon forbids launch prompts, timers and
repeated nudges, so the design is a single quiet invitation, and the holdout is what makes the
result worth anything.

## Dependencies

- Reports 08 and 09 read, so the eligible population and an experiment slot exist.
- The invitation surface designed and approved in Figma before an agent implements it.
- Report 02's per-product activation and retention views.

## Decision log

| Date | Decision | Numbers |
|---|---|---|
