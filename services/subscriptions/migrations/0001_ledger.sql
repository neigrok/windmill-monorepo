-- The ledger's identity: one row, whose epoch is minted here, when the ledger is created, and replaced
-- when the ledger is restored from a backup (spec §5.2). A feed cursor means something only within it.
create table ledger (
    one_row boolean primary key default true check (one_row),
    epoch uuid not null,
    created_at timestamptz not null default now()
);

insert into ledger (epoch) values (gen_random_uuid());
