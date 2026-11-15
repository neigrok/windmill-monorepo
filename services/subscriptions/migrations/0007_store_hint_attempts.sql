-- A hint the store refuses for a reason a retry cannot change waits before it is written again, as an inbox apply
-- does: 1, 2, 4 and 8 hours, and the fifth refusal settles it abandoned, so a hint the store never takes holds up none
-- behind it. A hint owed again starts over.
alter table store_hints
    add column attempts integer not null default 0,
    add column next_attempt_at bigint,
    add column abandoned_at bigint;
