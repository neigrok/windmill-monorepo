-- The account hints the ledger owes the stores (§4): written in the transaction that binds a subscription by claim,
-- cleared once the store has taken the hint, so a crash or a lost answer never loses one. The lineage is kept
-- beside it, since the store is called with it.
create table store_hints (
    subscription_id uuid primary key references subscriptions,
    store text not null check (store in ('app_store', 'play_store', 'paddle')),
    environment text not null check (environment in ('production', 'sandbox')),
    store_subscription_id text not null,
    account_id uuid not null,
    owed_since bigint not null default now_millis()
);
