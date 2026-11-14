-- One row per lineage (spec §3.1): what its newest statement says, its binding, and the stamps that order
-- statements (INV-6). A state's facts are present exactly in that state (§3.2); instants are epoch milliseconds.
create table subscriptions (
    id uuid primary key,
    store text not null check (store in ('app_store', 'play_store', 'paddle')),
    environment text not null check (environment in ('production', 'sandbox')),
    store_subscription_id text not null,
    account_id uuid,
    bound_at bigint,
    bound_by text check (bound_by in ('purchase', 'claim')),
    plan text not null check (plan in ('windmill_one')),
    product_id text not null,
    billing_interval text not null,
    started_at bigint not null,
    state text not null check (state in ('active', 'grace', 'on_hold', 'paused', 'expired', 'revoked')),
    current_period_starts_at bigint not null,
    current_period_ends_at bigint not null,
    pause_scheduled_for bigint,
    payment_failed_at bigint,
    grace_ends_at bigint,
    paused_at bigint,
    resumes_at bigint,
    ended_at bigint,
    end_reason text check (end_reason in ('cancelled', 'billing', 'price_change_declined', 'product_unavailable',
                                          'replaced', 'refunded', 'chargeback', 'sharing_removed', 'unknown')),
    auto_renew boolean not null,
    next_charge_at bigint,
    next_charge_amount text check (next_charge_amount ~ '^[0-9]+(\.[0-9]+)?$'),
    next_charge_currency text check (next_charge_currency ~ '^[A-Z]{3}$'),
    next_product_id text,
    cancel_requested_at bigint,
    offer_kind text check (offer_kind in ('free_trial', 'introductory', 'promotional', 'offer_code', 'win_back')),
    offer_ends_at bigint,
    price_amount text not null check (price_amount ~ '^[0-9]+(\.[0-9]+)?$'),
    price_currency text not null check (price_currency ~ '^[A-Z]{3}$'),
    storefront text,
    observed_at bigint not null,
    cancellation_observed_at bigint,
    -- The last time the service pulled this subscription's state from its store: the sweep's bookkeeping.
    verified_at bigint,
    unique (store, environment, store_subscription_id),
    check (num_nulls(account_id, bound_at, bound_by) in (0, 3)),
    check (num_nulls(next_charge_at, next_charge_amount, next_charge_currency) in (0, 3)),
    check (offer_kind is not null or offer_ends_at is null),
    check (case state
        when 'active' then num_nulls(payment_failed_at, grace_ends_at, paused_at, resumes_at, ended_at, end_reason) = 6
        when 'grace' then num_nulls(payment_failed_at, grace_ends_at) = 0
            and num_nulls(pause_scheduled_for, paused_at, resumes_at, ended_at, end_reason) = 5
        when 'on_hold' then payment_failed_at is not null
            and num_nulls(pause_scheduled_for, grace_ends_at, paused_at, resumes_at, ended_at, end_reason) = 6
        when 'paused' then paused_at is not null
            and num_nulls(pause_scheduled_for, payment_failed_at, grace_ends_at, ended_at, end_reason) = 5
        else num_nulls(ended_at, end_reason) = 0
            and num_nulls(pause_scheduled_for, payment_failed_at, grace_ends_at, paused_at, resumes_at) = 5
    end)
);

create index subscriptions_of_account on subscriptions (account_id) where account_id is not null;

-- D-4: one row per store transaction of a lineage. Its stretch, price and offer are its first statement's;
-- afterwards only its refund time and the stamp of the newest statement of it change (INV-7), and left_with, the
-- account that paid for it, once a new purchase moves its subscription to another (R-11).
create table periods (
    id uuid primary key,
    subscription_id uuid not null references subscriptions,
    store_transaction_id text not null,
    starts_at bigint not null,
    ends_at bigint not null,
    price_amount text not null check (price_amount ~ '^[0-9]+(\.[0-9]+)?$'),
    price_currency text not null check (price_currency ~ '^[A-Z]{3}$'),
    offer_kind text check (offer_kind in ('free_trial', 'introductory', 'promotional', 'offer_code', 'win_back')),
    refunded_at bigint,
    observed_at bigint not null,
    left_with uuid,
    unique (subscription_id, store_transaction_id)
);
