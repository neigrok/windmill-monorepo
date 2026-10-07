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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--maintenance-db", default=SchemaReapplicationTest.maintenance)
    arguments, remaining = parser.parse_known_args()
    SchemaReapplicationTest.maintenance = arguments.maintenance_db
    unittest.main(argv=[__file__, *remaining])
