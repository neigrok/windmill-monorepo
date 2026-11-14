-- The newest seq the ledger has given. A transaction takes its events' seqs by updating this row and holds the
-- row's lock until it commits, so seq order is commit order (INV-8).
alter table ledger add column latest_seq bigint not null default 0;

-- D-6, append-only. Each event keeps what the feed carries as it stood after the transaction that recorded it
-- (spec §5.2): its subscription's offer kind, and on a period event the period as that event states it.
create table events (
    seq bigint primary key check (seq > 0),
    type text not null check (type in (
        'started', 'renewed', 'renewal_turned_off', 'renewal_turned_on', 'payment_failed', 'payment_recovered',
        'pause_scheduled', 'paused', 'resumed', 'plan_change_scheduled', 'plan_changed', 'period_extended',
        'updated', 'expired', 'revoked', 'revocation_reversed', 'bound', 'unbound',
        'period_recorded', 'period_refunded', 'period_refund_reversed')),
    occurred_at bigint not null,
    recorded_at bigint not null,
    subscription_id uuid not null references subscriptions,
    account_id uuid,
    store text not null check (store in ('app_store', 'play_store', 'paddle')),
    environment text not null check (environment in ('production', 'sandbox')),
    subscription_offer_kind text check (subscription_offer_kind in (
        'free_trial', 'introductory', 'promotional', 'offer_code', 'win_back')),
    period_id uuid references periods,
    period_store_transaction_id text,
    period_starts_at bigint,
    period_ends_at bigint,
    period_price_amount text check (period_price_amount ~ '^[0-9]+(\.[0-9]+)?$'),
    period_price_currency text check (period_price_currency ~ '^[A-Z]{3}$'),
    period_offer_kind text check (period_offer_kind in (
        'free_trial', 'introductory', 'promotional', 'offer_code', 'win_back')),
    period_refunded_at bigint,
    period_observed_at bigint,
    period_left_with uuid,
    check (num_nulls(period_id, period_store_transaction_id, period_starts_at, period_ends_at, period_price_amount,
                     period_price_currency, period_observed_at)
           = case when type in ('period_recorded', 'period_refunded', 'period_refund_reversed') then 0 else 7 end),
    check (period_id is not null or num_nulls(period_offer_kind, period_refunded_at, period_left_with) = 3)
);

-- A subscription's newest event, which a claim answers with however often it is retried (§5.2).
create index events_of_subscription on events (subscription_id, seq);

-- The subscriptions an event's entitlement folds over: its account's, as they stood after the transaction that
-- recorded the event (spec §5.2). An event that names no account has none.
create table entitlement_subscriptions (
    seq bigint not null references events,
    like subscriptions including constraints,
    primary key (seq, id),
    foreign key (id) references subscriptions
);

-- verifiedAt is the sweep's bookkeeping, not part of the subscription an entitlement folds.
alter table entitlement_subscriptions drop column verified_at;
