# Funnel views

The analyst surface over the event spine (`events`) and the server-truth tables. Lives outside
`schema.sql`; the app never reads it. Apply (idempotent):

```
psql windmill -f db/funnel.sql
```

Weeks are ISO weeks; `week` is the Monday of the bucket. Beacon-sourced numbers undercount (adblock,
tabs closed before flush); rows from `users`/`trees`/`node_progress` are ground truth.

Activated = owns a tree with ≥3 present nodes and completed a node on it within 48h of that tree's
creation.

| View | Rows |
|---|---|
| `funnel_weekly_signups` | accounts created per week — the cohort denominator |
| `funnel_activation` | one per account: signup time, first owned tree (id, time, node count), first completion, `activated`, hours to each |
| `funnel_weekly_activation` | per cohort: signups → planted (≥1 owned tree) → activated, and the rate over the whole cohort |
| `funnel_shares` | per week: share_export / link_copy / fork_attempt (by mode: instant vs email) / fork_claim beacons beside `forked_trees` from `trees.forked_from` — beacons are intent, `forked_trees` is what happened |
| `funnel_returns` | per cohort: share of accounts with any activity (progress write, edit to an owned tree, attributed event) in days 7–14. The rate divides by `eligible` (accounts past day 14), so young cohorts read as no-data, not churn |
| `funnel_landing` | per week, from beacons: lands (and how many arrived signed out), demo opens, tree births, sign-ins |

## The weekly report

```
psql windmill -c "select * from funnel_weekly_activation order by week desc limit 8;"
psql windmill -c "select * from funnel_landing order by week desc limit 8;"
psql windmill -c "select * from funnel_shares order by week desc limit 8;"
psql windmill -c "select * from funnel_returns order by week desc limit 8;"
psql windmill -c "select * from funnel_activation order by signed_up_at desc limit 20;"   # drill-down
```

Empty results mean no data yet, not a broken view.
