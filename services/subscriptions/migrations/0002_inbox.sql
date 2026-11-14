-- The ledger's own clock, in epoch milliseconds: the unit the domain and every wire count instants in.
create function now_millis() returns bigint
    language sql volatile
    return (extract(epoch from clock_timestamp()) * 1000)::bigint;

-- What the stores sent, kept under each store's own id for the notification before anything is applied
-- (spec §5.1 step 3). Settling one records what applying it came to; the sweep applies the rest (§7).
create table inbox (
    store text not null check (store in ('app_store', 'play_store', 'paddle')),
    notification_id text not null,
    environment text not null check (environment in ('production', 'sandbox')),
    signed_payload text not null,
    received_at bigint not null default now_millis(),
    settled_at bigint,
    outcome text,
    primary key (store, notification_id),
    check ((settled_at is null) = (outcome is null))
);

create index inbox_unsettled on inbox (received_at, notification_id) where settled_at is null;
