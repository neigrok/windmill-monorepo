-- Analyst views; the app never reads them. Idempotent: `psql windmill -f db/funnel.sql`.
-- Weeks are ISO weeks and `week` is that Monday's date.

create or replace view funnel_weekly_signups as
select date_trunc('week', created_at)::date as week,
       count(*)                             as signups
from users
group by 1;

-- Soft-deleted trees still count as activation. node_progress is an LWW register, so
-- first_completed_at undercounts: a completion later cleared reads as never-happened.
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

-- planted = ≥1 owned tree ever. activation_rate is over the whole cohort, not planters.
create or replace view funnel_weekly_activation as
select date_trunc('week', signed_up_at)::date            as week,
       count(*)                                          as signups,
       count(*) filter (where first_tree_id is not null) as planted,
       count(*) filter (where activated)                 as activated,
       round(count(*) filter (where activated)::numeric / nullif(count(*), 0), 2)
                                                         as activation_rate
from funnel_activation
group by 1;

-- *_beacons count client events and undercount; forked_trees is ground truth.
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

-- W1 return = any activity in days 7–14 after signup. The rate divides by eligible (day-14 window
-- closed), so a young cohort reads as no-data rather than churn.
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

-- props.signedIn is a json boolean, so the text projection compares 'false'.
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
