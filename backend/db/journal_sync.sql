-- Explicit Appendix D adoption after schema.sql, under the shared gym/journal freeze.
-- Tests apply it only in WM_SYNC_DATABASE_URL; regular deployment does not apply it.
alter table journal_page add column if not exists seq bigint;
alter table journal_page add column if not exists rc bigint;
alter table journal_page add column if not exists ru bigint;
alter table journal_page add column if not exists mood_stamp text;
alter table journal_page add column if not exists energy_stamp text;
alter table journal_page add column if not exists source_stamp text;
alter table journal_page add column if not exists document_stamp_stamp text;
alter table journal_page add column if not exists body_rev bigint;
alter table journal_page add column if not exists body_merged boolean;
create index if not exists journal_page_sync_feed on journal_page(user_id, seq);

alter table journal_page_revision add column if not exists migration_id bigint;
alter table journal_page_revision add column if not exists engine_rev bigint;
create unique index if not exists journal_page_revision_engine_rev on journal_page_revision(user_id, engine_rev);
create unique index if not exists journal_page_revision_migration_id on journal_page_revision(user_id, migration_id);

create table if not exists journal_sync_state (
  user_id uuid primary key references users(id) on delete cascade,
  placeholder text not null default 'pending', placeholder_stamp text,
  privacy_line text not null default 'pending', privacy_line_stamp text,
  first_page text not null default 'pending', first_page_stamp text,
  scales text not null default 'pending', scales_stamp text,
  seq bigint, rc bigint, ru bigint
);
create index if not exists journal_sync_state_feed on journal_sync_state(user_id, seq);

create table if not exists journal_sync_adoptions (
  user_id uuid primary key references users(id) on delete cascade,
  migration_ms bigint not null,
  first_run_policy text not null check(first_run_policy = 'retire-existing'),
  manifest_digest text not null,
  frozen_input jsonb not null,
  frozen_receipts jsonb not null default '{}'::jsonb
);
create table if not exists journal_claim_receipts (
  user_id uuid not null references users(id) on delete cascade,
  claim_id text not null,
  arguments_digest text not null,
  day date not null,
  document_stamp jsonb not null,
  primary key(user_id, claim_id)
);
create table if not exists journal_content_clock (
  user_id uuid primary key references users(id) on delete cascade,
  ms bigint not null,
  counter bigint not null
);

create or replace function journal_sync_adoption_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'journal adoption source and migration clock are immutable';
end $$;
drop trigger if exists journal_sync_adoption_immutable on journal_sync_adoptions;
create trigger journal_sync_adoption_immutable before update on journal_sync_adoptions
  for each row execute function journal_sync_adoption_immutable();

create or replace function journal_sync_revision_identity_immutable() returns trigger language plpgsql as $$
begin
  if old.migration_id is not null and
     (new.migration_id is distinct from old.migration_id or new.engine_rev is distinct from old.engine_rev) then
    raise exception 'journal frozen revision identity is immutable';
  end if;
  return new;
end $$;
drop trigger if exists journal_sync_revision_identity_immutable on journal_page_revision;
create trigger journal_sync_revision_identity_immutable before update on journal_page_revision
  for each row execute function journal_sync_revision_identity_immutable();
