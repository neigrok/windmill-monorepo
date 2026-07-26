# Funnel views

The analyst surface over the event spine (`events`) and the server-truth tables. Lives
outside `schema.sql` on purpose — the app never reads these, and redefining a metric is
not a schema migration. Apply (and re-apply, it's idempotent) with:

```
psql windmill -f db/funnel.sql
```

All weeks are ISO weeks; `week` is the Monday date of the bucket. Beacon-sourced numbers
undercount (adblock, tabs closed before flush); rows from `users`/`trees`/`node_progress`
are ground truth.

## The views

**funnel_weekly_signups** — accounts created per ISO week.
The cohort denominator every other view slices by.

**funnel_activation** — one row per account: signup time, first owned tree (id, time,
present-node count), first completion, `activated`, hours to first tree / first completion.
Activated = owns a tree with ≥3 present nodes and completed a node on it within 48h of
that tree's creation (the PRODUCT_LOG metric contract).

**funnel_weekly_activation** — per signup cohort: signups → planted (≥1 owned tree) →
activated, with the activation rate over the whole cohort.
This is the weekly report's headline table.

**funnel_shares** — the share→visit→fork edge per week: share_export / link_copy /
fork_attempt (split by mode: instant vs email) / fork_claim beacons, next to `forked_trees`
counted from `trees.forked_from` — the beacons show intent, `forked_trees` is what happened.

**funnel_returns** — W1 return per signup cohort: share of accounts with any activity
(a node_progress write, an edit to an owned tree, or an attributed event) in days 7–14
after signup. Rate divides by `eligible` (accounts past day 14), so young cohorts read
as no-data, not churn.

**funnel_landing** — the anonymous top of funnel per week, straight from beacons:
lands (and how many arrived signed out), demo opens, tree births, sign-ins.

## The weekly report

```
psql windmill -c "select * from funnel_weekly_activation order by week desc limit 8;"
psql windmill -c "select * from funnel_landing order by week desc limit 8;"
psql windmill -c "select * from funnel_shares order by week desc limit 8;"
psql windmill -c "select * from funnel_returns order by week desc limit 8;"
```

Per-account drill-down when a cohort looks off:

```
psql windmill -c "select * from funnel_activation order by signed_up_at desc limit 20;"
```

Empty results mean no data yet, not a broken view.
