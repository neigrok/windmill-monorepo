-- Windmill funnel views — the analyst surface over the event spine + server-truth
-- tables. Deliberately not in schema.sql: the app never reads these, and redefining a
-- metric shouldn't look like a schema migration. Idempotent; re-apply any time with
-- `psql windmill -f db/funnel.sql`. Each view is a plain aggregate, so empty tables
-- yield empty results, never errors.
--
-- Weeks are ISO weeks — date_trunc('week', …) starts Monday — and `week` is that
-- Monday's date. node_progress.user_id is text (the domain's string ids), so joins to
-- users.id go through ::text.

-- accounts created per ISO week: the cohort denominator every other view slices by.
create or replace view funnel_weekly_signups as
select date_trunc('week', created_at)::date as week,
       count(*)                             as signups
from users
group by 1;

-- per-account activation ledger (the PRODUCT_LOG metric contract): activated = owns a
-- tree with ≥3 present nodes AND completed a node on that tree within 48h of the tree's
-- creation. Soft-deleted trees still count — the behaviour happened; deleting a tree
-- later doesn't retro-deactivate the cohort. node_progress is an LWW register, not a
-- log, so first_completed_at is min(updated_at) over rows still 'complete': a completion
-- later cleared reads as never-happened, a re-completed node reads late — an undercount,
-- never an overcount.
create or replace view funnel_activation as
select
  u.id                          as user_id,
  u.email,
  u.created_at                  as signed_up_at,
  first_tree.tree_id            as first_tree_id,
  first_tree.created_at         as first_tree_at,
  first_tree.node_count         as first_tree_nodes,
  first_completion.completed_at as first_completed_at,
  exists (
    select 1
    from trees t
    where t.owner_id = u.id
      and 3 <= (select count(*) from tree_nodes n
                where n.tree_id = t.id and n.present)
      and exists (select 1 from node_progress np
                  where np.tree_id = t.id
                    and np.user_id = u.id::text
                    and np.status = 'complete'
                    and np.updated_at <= t.created_at + interval '48 hours')
  )                             as activated,
  round((extract(epoch from first_tree.created_at - u.created_at) / 3600)::numeric, 1)
                                as hours_to_first_tree,
  round((extract(epoch from first_completion.completed_at - u.created_at) / 3600)::numeric, 1)
                                as hours_to_first_completion
from users u
left join lateral (
  select t.id as tree_id,
         t.created_at,
         (select count(*) from tree_nodes n
          where n.tree_id = t.id and n.present) as node_count
  from trees t
  where t.owner_id = u.id
  order by t.created_at
  limit 1
) first_tree on true
left join lateral (
  select min(np.updated_at) as completed_at
  from node_progress np
  where np.user_id = u.id::text and np.status = 'complete'
) first_completion on true;

-- the weekly report: signups → planted (≥1 owned tree, ever) → activated, per signup
-- cohort. activation_rate is over the whole cohort, not just planters.
create or replace view funnel_weekly_activation as
select date_trunc('week', signed_up_at)::date            as week,
       count(*)                                          as signups,
       count(*) filter (where first_tree_id is not null) as planted,
       count(*) filter (where activated)                 as activated,
       round(count(*) filter (where activated)::numeric / nullif(count(*), 0), 2)
                                                         as activation_rate
from funnel_activation
group by 1;

-- the share→visit→fork edge. *_beacons columns count client events and undercount
-- (adblock, tabs closed before the flush); forked_trees counts trees.forked_from and is
-- ground truth. fork_attempt carries props.mode — 'instant' (guest fork) vs 'email'
-- (fork rides the magic link).
create or replace view funnel_shares as
with beacons as (
  select date_trunc('week', ts)::date as week,
         count(*) filter (where name = 'share_export')                                as share_export_beacons,
         count(*) filter (where name = 'link_copy')                                   as link_copy_beacons,
         count(*) filter (where name = 'fork_attempt' and props->>'mode' = 'instant') as fork_attempt_instant_beacons,
         count(*) filter (where name = 'fork_attempt' and props->>'mode' = 'email')   as fork_attempt_email_beacons,
         count(*) filter (where name = 'fork_claim')                                  as fork_claim_beacons
  from events
  where name in ('share_export', 'link_copy', 'fork_attempt', 'fork_claim')
  group by 1
),
forks as (
  select date_trunc('week', created_at)::date as week,
         count(*)                             as forked_trees
  from trees
  where forked_from is not null
  group by 1
)
select week,
       coalesce(share_export_beacons, 0)         as share_export_beacons,
       coalesce(link_copy_beacons, 0)            as link_copy_beacons,
       coalesce(fork_attempt_instant_beacons, 0) as fork_attempt_instant_beacons,
       coalesce(fork_attempt_email_beacons, 0)   as fork_attempt_email_beacons,
       coalesce(fork_claim_beacons, 0)           as fork_claim_beacons,
       coalesce(forked_trees, 0)                 as forked_trees
from beacons
full join forks using (week);

-- W1 return: of a signup cohort, who did anything in days 7–14 after signup — a
-- node_progress write, an edit to an owned tree (trees.updated_at), or any attributed
-- event. eligible counts only accounts whose day-14 window has closed, and the rate
-- divides by eligible, so a young cohort reads as no-data rather than churn.
create or replace view funnel_returns as
select date_trunc('week', u.created_at)::date              as week,
       count(*)                                            as signups,
       count(*) filter (where r.window_closed)             as eligible,
       count(*) filter (where r.window_closed and r.returned) as returned_w1,
       round(count(*) filter (where r.window_closed and r.returned)::numeric
             / nullif(count(*) filter (where r.window_closed), 0), 2)
                                                           as w1_return_rate
from users u
cross join lateral (
  select u.created_at + interval '14 days' <= now() as window_closed,
         (   exists (select 1 from node_progress np
                     where np.user_id = u.id::text
                       and np.updated_at >= u.created_at + interval '7 days'
                       and np.updated_at <  u.created_at + interval '14 days')
          or exists (select 1 from trees t
                     where t.owner_id = u.id
                       and t.updated_at >= u.created_at + interval '7 days'
                       and t.updated_at <  u.created_at + interval '14 days')
          or exists (select 1 from events e
                     where e.user_id = u.id
                       and e.ts >= u.created_at + interval '7 days'
                       and e.ts <  u.created_at + interval '14 days')
         )                                          as returned
) r
group by 1;

-- the anonymous top of funnel, straight from beacons: landings (and how many arrived
-- signed out), demo opens, tree births, sign-ins. land carries props.signedIn as a json
-- boolean, so the text projection compares against 'false'.
create or replace view funnel_landing as
select date_trunc('week', ts)::date as week,
       count(*) filter (where name = 'land')                                  as lands,
       count(*) filter (where name = 'land' and props->>'signedIn' = 'false') as lands_signed_out,
       count(*) filter (where name = 'demo_open')                             as demo_opens,
       count(*) filter (where name = 'birth')                                 as births,
       count(*) filter (where name = 'sign_in')                               as sign_ins
from events
where name in ('land', 'demo_open', 'birth', 'sign_in')
group by 1;
