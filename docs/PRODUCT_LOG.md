# Windmill product strategy

Windmill helps people develop themselves through three products: roadmap for a plan, journal for
daily reflection, and gym for training. One account connects the products. The
[repository map](../STRUCTURE.md) defines their surfaces and dependency boundaries.

The bet ledger lives in the dogfood tree, `t_9362d9bc883e0a1e`. Each bet's node carries its
scope, progress, outcome and follow-ups. Implementation plans and delivery history belong there.

## Shared principles

- Product copy describes available behavior. No manufactured urgency or promises based on an
  unbuilt feature.
- People control their data and an assistant's access to it. Connected tools are granted access
  per product and permission level.
- Ordinary use of the editor, journal and training log remains free. Products share one paid
  entitlement, Windmill One, rather than defining independent subscriptions.
- Only actively requested AI work counts against the account AI allowance. Passive Echoes has a
  separate operational budget. Customer credit quantities and conversion are not approved.

Checkout is closed: `paidPlansOpen()` returns false, and the server refuses checkout without a
configured Paddle price. [AI usage and billing](AI_USAGE_REVIEW.md) records the implemented limits
and the gaps a shared usage screen must resolve.

## Roadmap

Turn a plan into a skill tree with meaningful prerequisites and visible completion. The editor,
paste import, sharing and MCP tools serve the same graph. An owner explicitly publishes a tree
before sharing a public link; visitors can fork it.

The product measures activation as a tree with at least three nodes and a first completion within
48 hours. Retention focuses on return visits and further completions. Share-link visits, forks and
claimed forks form the distribution loop. Numeric targets require real funnel data.

Current system contracts are in [roadmap backend](../backend/SPEC.md),
[graph sync](GRAPH_SYNC_DESIGN.md) and [roadmap design](design/roadmap/readme.md).

## Journal

Give daily writing a quiet home. Search helps the writer find their own words; Echoes connects
related passages. Talk transcribes audio where the account and configured service allow it.

Current behavior and privacy boundaries are in
[journal architecture](../backend/products/journal/ARCHITECTURE.md) and
[journal design](design/journal/journal.md).

## Gym

Serve a lifter following a repeatable program. Reliable records and a useful prefilled weight make
logging fast. Native apps own workout entry; the web provides a live mirror, planning, history and
Coach.

Connected assistants can record supplied workout facts and create a requested routine. Changes to
an existing routine remain proposals until the lifter applies them. Coach keeps its conversation,
read receipts and action results together; it can save a new user-supplied insight to Notes.

Gym activation means returning: at least two sessions of five sets within seven days of the first
set. Useful measures are prefill acceptance, week-one and week-four return, and correction rate.
A weight increased by one program step can be a successful prefill.

Current data rules are in [gym architecture](../backend/products/gym/ARCHITECTURE.md),
[Coach's wire contract](gym-coach-contract.md) and [gym design](design/gym/briefs/00-README.md).
