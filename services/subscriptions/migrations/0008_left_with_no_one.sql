-- A period whose account was erased stays with no one (spec §6.4): no later event of it names an account. left_with
-- names the account a new purchase moved its subscription from (R-11); the two never hold together.
alter table periods
    add column left_with_no_one boolean not null default false,
    add check (not (left_with_no_one and left_with is not null));

-- Each period event keeps the period as it stated it, this too; an event of no period states none.
alter table events
    add column period_left_with_no_one boolean not null default false,
    add check (not (period_left_with_no_one and period_left_with is not null)),
    add check (period_id is not null or not period_left_with_no_one);

-- An erasure finds the periods its account paid for on subscriptions a new purchase moved away (R-11).
create index periods_left_with on periods (left_with) where left_with is not null;
