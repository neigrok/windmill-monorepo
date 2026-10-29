#!/usr/bin/env python3
import argparse
import difflib
import os
from pathlib import Path
import re
import subprocess
import unittest
from urllib.parse import urlsplit, urlunsplit
import uuid


SCHEMA = Path(__file__).resolve().parents[2] / "db/schema.sql"
CATALOG = """
select definition from (
select 'constraint' as kind, r.relname as relation, c.conname as name,
  json_build_object('kind', 'constraint', 'table', r.relname,
  'name', c.conname, 'oid', c.oid, 'definition', pg_get_constraintdef(c.oid),
  'delete_action', c.confdeltype, 'update_action', c.confupdtype,
  'deferrable', c.condeferrable, 'deferred', c.condeferred, 'validated', c.convalidated)::text as definition
from pg_constraint c join pg_class r on r.oid=c.conrelid
join pg_namespace n on n.oid=r.relnamespace
where n.nspname='public'
union all
select 'trigger' as kind, r.relname as relation, t.tgname as name,
  json_build_object('kind', 'trigger', 'table', r.relname,
  'name', t.tgname, 'oid', t.oid, 'definition', pg_get_triggerdef(t.oid),
  'enabled', t.tgenabled, 'internal', t.tgisinternal)::text as definition
from pg_trigger t join pg_class r on r.oid=t.tgrelid
join pg_namespace n on n.oid=r.relnamespace
where n.nspname='public'
) catalog order by kind, relation, name;
"""


def command(arguments):
    result = subprocess.run(arguments, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{Path(arguments[0]).name} failed: {result.stderr}")
    return result.stdout


class SchemaReapplicationTest(unittest.TestCase):
    maintenance = os.environ.get("DATABASE_URL", "postgresql:///postgres?host=/tmp")

    def setUp(self):
        name = "wm_schema_reapplication_" + uuid.uuid4().hex[:12]
        command(["createdb", "--maintenance-db=" + self.maintenance, name])
        self.addCleanup(command, ["dropdb", "--maintenance-db=" + self.maintenance, name])
        parts = urlsplit(self.maintenance)
        self.database = urlunsplit(parts._replace(path="/" + name))
        if not parts.netloc:
            self.database = parts.scheme + ":///" + name + ("?" + parts.query if parts.query else "")

    def apply_schema(self):
        command(["psql", self.database, "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(SCHEMA)])

    def snapshot(self):
        dump = command(["pg_dump", "--dbname=" + self.database])
        return {"pg_dump": re.sub(r"^\\(?:un)?restrict .+\n", "", dump, flags=re.MULTILINE),
                "constraints and triggers": command(["psql", self.database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", CATALOG])}

    def test_reapplying_schema_to_a_fresh_database_changes_nothing(self):
        self.apply_schema()
        before = self.snapshot()
        self.apply_schema()
        after = self.snapshot()
        for name in before:
            with self.subTest(snapshot=name):
                difference = "".join(difflib.unified_diff(before[name].splitlines(keepends=True),
                    after[name].splitlines(keepends=True), fromfile="first apply", tofile="second apply"))
                self.assertEqual(before[name], after[name], f"{name} changed:\n{difference}")

    def test_load_upgrade_preserves_signed_zero_and_absence_and_has_stable_finite_cent_checks(self):
        self.apply_schema()
        query = ["psql", self.database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c"]
        command([*query, """
insert into users(id,email) values('00000000-0000-4000-8000-000000000043','loads@example.invalid');
insert into gym_routines(id,user_id,name,position) values('routine-load-schema','00000000-0000-4000-8000-000000000043','Fixture',0);
insert into gym_routine_entries(routine_id,position,exercise_id) values('routine-load-schema',1,'bench-press');
insert into gym_routine_entry_sets(routine_id,position,set_index,reps,weight_kg)
  values('routine-load-schema',1,1,8,-500),('routine-load-schema',1,2,8,0),('routine-load-schema',1,3,8,null);
insert into gym_sessions(id,user_id,started_at) values('session-load-schema','00000000-0000-4000-8000-000000000043',to_timestamp(1));
insert into gym_sets(id,session_id,user_id,exercise_id,set_number,weight_kg,reps,completed_at)
  values('set-load-schema','session-load-schema','00000000-0000-4000-8000-000000000043','bench-press',1,500,1,to_timestamp(2));
insert into gym_set_revisions(set_id,session_id,user_id,exercise_id,set_number,weight_kg,reps,note,completed_at)
  select id,session_id,user_id,exercise_id,set_number,-500,reps,note,completed_at from gym_sets where id='set-load-schema';
set constraints all immediate;
alter table gym_routine_entry_sets drop constraint gym_routine_entry_sets_load_finite_cent,
  alter column weight_kg type numeric(6,2), add check(weight_kg between -500 and 500);
alter table gym_sets drop constraint gym_sets_load_finite_cent,
  alter column weight_kg type numeric(6,2), add check(weight_kg between -500 and 500);
alter table gym_set_revisions alter column weight_kg type numeric(6,2);
"""])
        self.apply_schema()
        before = self.snapshot()
        self.apply_schema()
        self.assertEqual(before, self.snapshot())
        self.assertEqual(command([*query, """
select string_agg(relname||':'||atttypmod,',' order by relname)
from pg_attribute join pg_class on pg_class.oid=attrelid
where relname in ('gym_routine_entry_sets','gym_sets','gym_set_revisions') and attname='weight_kg';
"""]).strip(), "gym_routine_entry_sets:-1,gym_set_revisions:-1,gym_sets:-1")
        self.assertEqual(command([*query, """
select (select weight_kg=-500 from gym_routine_entry_sets where routine_id='routine-load-schema' and set_index=1)
  and (select weight_kg=0 from gym_routine_entry_sets where routine_id='routine-load-schema' and set_index=2)
  and (select weight_kg is null from gym_routine_entry_sets where routine_id='routine-load-schema' and set_index=3)
  and (select weight_kg=500 from gym_sets where id='set-load-schema')
  and (select weight_kg=-500 from gym_set_revisions where set_id='set-load-schema');
"""]).strip(), "t")
        command([*query, """
do $$
declare relation text; sample text;
begin
  foreach relation in array array['gym_routine_entry_sets','gym_sets'] loop
    foreach sample in array array['501','-501','0','0.1','35333333333333.34','1.7976931348623157e308','-1.7976931348623157e308'] loop
      execute format('update %I set weight_kg=$1',relation) using sample::numeric;
    end loop;
    foreach sample in array array['NaN','Infinity','-Infinity','0.001','-0.001'] loop
      begin
        execute format('update %I set weight_kg=$1',relation) using sample::numeric;
        raise exception 'invalid live load was accepted';
      exception when check_violation then null; end;
    end loop;
  end loop;
end $$;
update gym_routine_entry_sets set weight_kg=null where routine_id='routine-load-schema' and set_index=3;
update gym_set_revisions set weight_kg=1.001 where set_id='set-load-schema';
"""])

    def test_other_equipment_upgrade_keeps_legacy_metadata_and_signed_history(self):
        self.apply_schema()
        query = ["psql", self.database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c"]
        command([*query, """
alter table gym_exercises drop constraint gym_exercises_equipment_check,
  add constraint gym_exercises_equipment_check check (equipment in ('barbell','dumbbell','machine','cable','bodyweight','kettlebell'));
alter table gym_exercise_names drop constraint gym_exercise_names_equipment_check,
  add constraint gym_exercise_names_equipment_check check (equipment in ('barbell','dumbbell','machine','cable','bodyweight','kettlebell'));
insert into users(id,email) values('00000000-0000-4000-8000-000000000042','equipment@example.invalid');
insert into gym_exercises(id,name,pattern,equipment,created_by)
  select 'legacy-'||equipment,equipment,'pull',equipment,'00000000-0000-4000-8000-000000000042'
  from unnest(array['barbell','dumbbell','machine','cable','bodyweight','kettlebell']) equipment;
insert into gym_exercise_names(user_id,exercise_id,equipment,load_count)
  values('00000000-0000-4000-8000-000000000042','dumbbell-row','dumbbell',1);
insert into gym_sessions(id,user_id,started_at)
  values('equipment-session','00000000-0000-4000-8000-000000000042',now());
insert into gym_sets(id,user_id,session_id,exercise_id,set_number,weight_kg,reps,completed_at)
  values('equipment-set','00000000-0000-4000-8000-000000000042','equipment-session','legacy-bodyweight',1,-12.5,8,now());
"""])
        legacy = """
select jsonb_build_object(
  'exercises', (select jsonb_agg(to_jsonb(t) order by id) from gym_exercises t where created_by='00000000-0000-4000-8000-000000000042'),
  'overrides', (select jsonb_agg(to_jsonb(t) order by exercise_id) from gym_exercise_names t where user_id='00000000-0000-4000-8000-000000000042'),
  'sets', (select jsonb_agg(to_jsonb(t) order by id) from gym_sets t where user_id='00000000-0000-4000-8000-000000000042')
)::text;
"""
        before = command([*query, legacy])
        self.apply_schema()
        self.assertEqual(before, command([*query, legacy]))
        command([*query, """
insert into gym_exercises(id,name,pattern,equipment,created_by)
  values('explicit-other','Other fixture','pull','other','00000000-0000-4000-8000-000000000042');
insert into gym_exercise_names(user_id,exercise_id,equipment)
  values('00000000-0000-4000-8000-000000000042','pull-up','other');
do $$ begin
  begin
    update gym_exercises set equipment='unknown' where id='explicit-other';
    raise exception 'unknown custom equipment was accepted';
  exception when check_violation then null; end;
  begin
    update gym_exercise_names set equipment='unknown' where exercise_id='pull-up';
    raise exception 'unknown seed equipment was accepted';
  exception when check_violation then null; end;
end $$;
"""])
        self.assertEqual("other\nother\n", command([*query, """
select equipment from gym_exercises where id='explicit-other'
union all select equipment from gym_exercise_names where exercise_id='pull-up';
"""]))
        upgraded_rows = command([*query, legacy])
        upgraded_constraints = command([*query, CATALOG])
        self.apply_schema()
        self.assertEqual(upgraded_rows, command([*query, legacy]))
        self.assertEqual(upgraded_constraints, command([*query, CATALOG]))

    def test_cutover_copies_are_removed_without_changing_live_rows(self):
        self.apply_schema()
        command(["psql", self.database, "-Xq", "-v", "ON_ERROR_STOP=1", "-c", """
insert into users(id,email,name) values('00000000-0000-4000-8000-000000000041','purge@example.invalid','Purge fixture');
insert into journal_page(user_id,day,body,mood,energy,seq,body_rev)
  values('00000000-0000-4000-8000-000000000041','2026-10-01','Current page',3,2,2,2);
insert into journal_page_revision(user_id,day,body,engine_rev)
  values('00000000-0000-4000-8000-000000000041','2026-10-01','Retained revision',1);
alter table journal_page_revision add column migration_id bigint;
update journal_page_revision set migration_id=1;
create unique index journal_page_revision_migration_id on journal_page_revision(user_id,migration_id);
create function journal_sync_revision_identity_immutable() returns trigger language plpgsql as $$
begin raise exception 'immutable'; end $$;
create trigger journal_sync_revision_identity_immutable before update on journal_page_revision
  for each row execute function journal_sync_revision_identity_immutable();
insert into gym_routines(id,user_id,name,position) values
  ('purge-routine','00000000-0000-4000-8000-000000000041','Current routine',0);
insert into gym_sessions(id,user_id,routine_id,started_at) values
  ('purge-session','00000000-0000-4000-8000-000000000041','purge-routine',now());
create table gym_sync_adoptions(user_id uuid primary key references users(id), frozen_source jsonb);
insert into gym_sync_adoptions select id,'{"notes":"Frozen gym copy"}'::jsonb from users;
create table journal_sync_adoptions(user_id uuid primary key references users(id), frozen_input jsonb);
insert into journal_sync_adoptions select id,'{"body":"Frozen journal copy"}'::jsonb from users;
create table gym_sync_metadata_upgrade_runs(version integer primary key, roster jsonb);
insert into gym_sync_metadata_upgrade_runs values(5,'["account"]');
create table gym_sync_metadata_upgrades(user_id uuid references users(id),
  version integer references gym_sync_metadata_upgrade_runs(version), frozen_source jsonb, result jsonb);
insert into gym_sync_metadata_upgrades select id,5,'{"body":"Frozen metadata copy"}','{}' from users;
"""])
        live_rows = """
select to_jsonb(t)::text from users t order by id;
select to_jsonb(t)::text from journal_page t order by user_id,day;
select (to_jsonb(t)-'migration_id')::text from journal_page_revision t order by user_id,engine_rev;
select to_jsonb(t)::text from gym_routines t order by id;
select to_jsonb(t)::text from gym_sessions t order by id;
select to_jsonb(t)::text from sync_meta t;
"""
        query = ["psql", self.database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c"]
        before = command([*query, live_rows])
        for attempt in (1, 2):
            with self.subTest(attempt=attempt):
                self.apply_schema()
                self.assertEqual(before, command([*query, live_rows]))
                self.assertEqual("0\n", command([*query, """
select count(*) from (
  select tablename as name from pg_tables where schemaname='public' and tablename in
    ('gym_sync_adoptions','journal_sync_adoptions','gym_sync_metadata_upgrade_runs','gym_sync_metadata_upgrades')
  union all select tgname from pg_trigger where tgname in
    ('gym_session_routine_identity','journal_sync_revision_identity_immutable')
  union all select proname from pg_proc where proname in
    ('gym_preserve_routine_identity','journal_sync_revision_identity_immutable')
  union all select column_name from information_schema.columns where table_schema='public'
    and table_name='journal_page_revision' and column_name='migration_id'
) retired;
"""]))

    def test_ai_output_offer_upgrade_preserves_legacy_rows_and_constraint_identity(self):
        self.apply_schema()
        query = ["psql", self.database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c"]
        command([*query, """
alter table ai_budget_reservations drop constraint ai_budget_output_offer;
alter table ai_budget_reservations drop column input_cost_nanos, drop column output_token_cost_nanos,
  drop column min_output_tokens, drop column max_output_tokens;
insert into ai_budget_reservations(id,subject_kind,subject_id,tier,period_start_ms,period_end_ms,
  admitted_at_ms,amount_nanos,state,actual_nanos)
select state,'account','legacy-account','logged_in',0,2678400000,1,100,state,actual
from (values ('reserved',null::bigint),('dispatched',null),('uncertain',null),('settled',50),('released',null)) old(state,actual);
"""])
        legacy_query = "select to_jsonb(t)::text from ai_budget_reservations t order by id"
        legacy_rows = command([*query, legacy_query])
        self.apply_schema()
        self.assertEqual(legacy_rows, command([*query, """
select (to_jsonb(t)-array['input_cost_nanos','output_token_cost_nanos','min_output_tokens','max_output_tokens'])::text
from ai_budget_reservations t order by id;
"""]))
        self.assertEqual("5\n", command([*query, """
select count(*) from ai_budget_reservations where input_cost_nanos is null and output_token_cost_nanos is null
  and min_output_tokens is null and max_output_tokens is null;
"""]))
        insert = """
insert into ai_budget_reservations(id,subject_kind,subject_id,tier,period_start_ms,period_end_ms,
  admitted_at_ms,amount_nanos,state,input_cost_nanos,output_token_cost_nanos,min_output_tokens,max_output_tokens)
values('adaptive','account','new-account','logged_in',0,2678400000,1,{amount},'reserved',{input},{unit},{floor},{ceiling});
"""
        for values in [dict(amount=47_500_000, input="null", unit=25_000, floor=1_024, ceiling=2_000),
                       dict(amount=47_500_001, input=10_000_000, unit=25_000, floor=1_024, ceiling=2_000),
                       dict(amount=35_575_000, input=10_000_000, unit=25_000, floor=1_024, ceiling=2_000),
                       dict(amount=60_025_000, input=10_000_000, unit=25_000, floor=1_024, ceiling=2_000),
                       dict(amount=1, input=0, unit=0, floor=1, ceiling=2),
                       dict(amount=1, input=0, unit=9_223_372_036_854_775_807, floor=1, ceiling=2)]:
            with self.subTest(offer=values):
                with self.assertRaisesRegex(RuntimeError, "ai_budget_output_offer"):
                    command([*query, insert.format(**values)])
        command([*query, insert.format(amount=47_500_000, input=10_000_000, unit=25_000, floor=1_024, ceiling=2_000)])
        constraint = """
select oid,pg_get_constraintdef(oid),convalidated from pg_constraint
where conrelid='ai_budget_reservations'::regclass and conname='ai_budget_output_offer';
"""
        identity = command([*query, constraint])
        self.assertRegex(identity, r"^\d+\|CHECK .+\|t\n$")
        before = self.snapshot()
        self.apply_schema()
        self.assertEqual(identity, command([*query, constraint]))
        self.assertEqual(before, self.snapshot())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--maintenance-db", default=SchemaReapplicationTest.maintenance)
    arguments, remaining = parser.parse_known_args()
    SchemaReapplicationTest.maintenance = arguments.maintenance_db
    unittest.main(argv=[__file__, *remaining])
