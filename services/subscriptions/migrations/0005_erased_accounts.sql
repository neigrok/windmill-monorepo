-- Accounts the backend erased (spec §6.4). A hint naming one counts as no hint, so it never binds again (§4).
create table erased_accounts (
    account_id uuid primary key,
    erased_at bigint not null default now_millis()
);
