-- R118 metadata supplement; apply after gym_sync.sql with every database writer stopped.
-- Ordinary deployment never applies this schema.

begin;

alter table gym_routines
  add column if not exists revision_stamp text,
  add column if not exists created_entries_stamp text;
alter table gym_proposals
  add column if not exists base_revision_stamp text,
  add column if not exists base_name_stamp text,
  add column if not exists change_count_stamp text;
alter table gym_notes add column if not exists updated_at_stamp text;
alter table gym_routine_creations
  add column if not exists seq bigint,
  add column if not exists rc bigint,
  add column if not exists ru bigint,
  add column if not exists snapshot_stamp text;
create index if not exists gym_routine_creations_sync_feed on gym_routine_creations(user_id, seq);

create table if not exists gym_sync_metadata_upgrade_runs (
  version integer primary key check(version = 5),
  run_id uuid not null unique,
  migration_ms bigint not null check(migration_ms >= 0),
  registry_hash text not null,
  epoch text not null,
  roster jsonb not null check(jsonb_typeof(roster) = 'array')
);
create table if not exists gym_sync_metadata_upgrades (
  user_id uuid not null references users(id) on delete cascade,
  version integer not null references gym_sync_metadata_upgrade_runs(version),
  migration_ms bigint not null check(migration_ms >= 0),
  frozen_source jsonb not null check(jsonb_typeof(frozen_source) = 'object'),
  result jsonb check(result is null or jsonb_typeof(result) = 'object'),
  primary key(user_id, version)
);
create or replace function gym_sync_metadata_run_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'gym metadata upgrade run is immutable';
end;
$$;
do $$ begin
  if not exists(select 1 from pg_trigger where tgrelid='gym_sync_metadata_upgrade_runs'::regclass and tgname='gym_sync_metadata_run_immutable') then
    create trigger gym_sync_metadata_run_immutable before update on gym_sync_metadata_upgrade_runs
      for each row execute function gym_sync_metadata_run_immutable();
  end if;
end $$;

create or replace function gym_sync_metadata_upgrade_immutable() returns trigger language plpgsql as $$
begin
  if old.result is not null or new.result is null or
     (to_jsonb(old) - 'result') is distinct from (to_jsonb(new) - 'result') then
    raise exception 'gym metadata upgrade source and committed result are immutable';
  end if;
  return new;
end;
$$;
do $$ begin
  if not exists(select 1 from pg_trigger where tgrelid='gym_sync_metadata_upgrades'::regclass and tgname='gym_sync_metadata_upgrade_immutable') then
    create trigger gym_sync_metadata_upgrade_immutable before update on gym_sync_metadata_upgrades
      for each row execute function gym_sync_metadata_upgrade_immutable();
  end if;
end $$;

commit;
