#!/usr/bin/env python3
import argparse
import difflib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from urllib.parse import urlsplit, urlunsplit
import uuid
import yaml


BACKEND = Path(__file__).resolve().parents[2]
INCOMPATIBLE_SCHEMA_REVISION = "4b18960d5d24855750a77f7904d8ea7b341a03b7"
ACCOUNT = "10000000-0000-4000-8000-000000000001"
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
    bin_dir = Path(os.environ.get("WM_MIGRATION_BIN_DIR", str(BACKEND / "build")))
    legacy_schema = None

    def setUp(self):
        self.name = "wm_schema_reapplication_" + uuid.uuid4().hex[:12]
        command(["createdb", "--maintenance-db=" + self.maintenance, self.name])
        self.addCleanup(command, ["dropdb", "--maintenance-db=" + self.maintenance, self.name])
        parts = urlsplit(self.maintenance)
        self.database = urlunsplit(parts._replace(path="/" + self.name))
        if not parts.netloc:
            self.database = parts.scheme + ":///" + self.name + ("?" + parts.query if parts.query else "")
        self.apply("schema.sql")
        self.sql(f"""
          insert into users(id, email) values ('{ACCOUNT}', 'schema-reapplication@example.test');
          insert into gym_routines(id, user_id, name, position)
            values ('routine_reapplication', '{ACCOUNT}', 'Routine', 0);
          insert into gym_sessions(id, user_id, routine_id, started_at, finished_at)
            values ('session_reapplication', '{ACCOUNT}', 'routine_reapplication',
              '2025-01-01T10:00:00Z', '2025-01-01T11:00:00Z');
          insert into journal_page(user_id, day, body, mood, energy)
            values ('{ACCOUNT}', '2025-01-01', 'A frozen page.', 0, 10);
        """)

    def sql(self, source):
        return command(["psql", self.database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", source]).strip()

    def apply(self, *files):
        command(["psql", self.database, "-Xq", "-v", "ON_ERROR_STOP=1",
                 *[argument for file in files for argument in ("-f", str(BACKEND / "db" / file))]])

    def deploy_schema(self, schema, runtime_root=BACKEND):
        compose = (BACKEND / "deploy/docker-compose.yml").read_text()
        arguments = yaml.safe_load(compose)["services"]["migrate"]["command"]
        self.assertIsInstance(arguments, list, "compose schema command must preserve argument boundaries")
        arguments = [self.database if argument.startswith("postgresql://windmill:")
                     else argument.replace("/app/db/schema.sql", str(schema))
                         .replace("/app/", str(runtime_root) + "/").replace("$$", "$")
                     for argument in arguments]
        return subprocess.run(arguments, capture_output=True, text=True)

    def schema_dump(self):
        dump = command(["pg_dump", "--dbname=" + self.database, "--schema-only"])
        return re.sub(r"^\\(?:un)?restrict .+\n", "", dump, flags=re.MULTILINE)

    def snapshot(self):
        return {"pg_dump --schema-only": self.schema_dump(), "triggers and constraints": self.sql(CATALOG)}

    def origin_schema(self):
        if self.legacy_schema:
            return self.legacy_schema.read_text()
        return command(["git", "-C", str(BACKEND), "show", f"{INCOMPATIBLE_SCHEMA_REVISION}:backend/db/schema.sql"])

    def run_rehearsal(self, schema):
        self.assertTrue((self.bin_dir / "windmill_gym_backfill").is_file(),
                        "real migration binaries are required; provide --bin-dir")
        with tempfile.TemporaryDirectory(prefix="wm-final-schema-audit-") as directory:
            backend = Path(directory) / "backend"
            for file in ("deploy/gym-migration/rehearse.py", "deploy/gym-migration/schema-compatibility.sh",
                         "db/gym_sync.sql", "db/journal_sync.sql", "products/gym/routes.cpp",
                         "products/journal/routes.cpp"):
                target = backend / file
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(BACKEND / file, target)
            (backend / "db/schema.sql").write_text(schema)
            return subprocess.run(["python3", str(backend / "deploy/gym-migration/rehearse.py"),
                "--bin-dir", str(self.bin_dir), "--output", str(Path(directory) / "evidence"),
                "--apply-adoption", "--now-ms", "1791000000000"],
                env={**os.environ, "DATABASE_URL": self.database}, capture_output=True, text=True)

    def assert_catalog_equal(self, before, after):
        for name in before:
            with self.subTest(snapshot=name):
                difference = "".join(difflib.unified_diff(before[name].splitlines(keepends=True),
                    after[name].splitlines(keepends=True), fromfile="before", tofile="after"))
                self.assertEqual(before[name], after[name], f"{name} changed:\n{difference}")

    def test_nonadopted_catalog_is_byte_identical_to_legacy_schema(self):
        current = self.schema_dump()
        legacy_name = "wm_legacy_catalog_" + uuid.uuid4().hex[:12]
        command(["createdb", "--maintenance-db=" + self.maintenance, legacy_name])
        self.addCleanup(command, ["dropdb", "--maintenance-db=" + self.maintenance, legacy_name])
        current_database = self.database
        self.database = current_database.replace("/" + self.name, "/" + legacy_name)
        try:
            with tempfile.TemporaryDirectory(prefix="wm-legacy-catalog-") as directory:
                schema = Path(directory) / "schema.sql"
                schema.write_text(self.origin_schema())
                command(["psql", self.database, "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(schema)])
            self.assert_catalog_equal({"pg_dump --schema-only": self.schema_dump()},
                                      {"pg_dump --schema-only": current})
            legacy_before = self.schema_dump()
            self.apply("schema.sql")
            self.assert_catalog_equal({"pg_dump --schema-only": legacy_before},
                                      {"pg_dump --schema-only": self.schema_dump()})
        finally:
            self.database = current_database

    def test_fresh_deploy_keeps_legacy_schema_and_behavior(self):
        before = self.snapshot()
        self.apply("schema.sql")
        self.assert_catalog_equal(before, self.snapshot())
        self.assertEqual(self.sql("select to_regclass('gym_sync_adoptions') is null "
                                  "and to_regclass('journal_sync_adoptions') is null"), "t")
        self.assertEqual(self.sql("select count(*) from pg_trigger where "
                                  "tgrelid='gym_sessions'::regclass and tgname='gym_session_routine_identity'"), "1")
        self.assertEqual(self.sql("select history_routine_id from gym_sessions "
                                  "where id='session_reapplication'"), "routine_reapplication")
        self.assertEqual(self.sql("select confdeltype, condeferrable, condeferred from pg_constraint "
                                  "where conrelid='gym_sessions'::regclass and conname='gym_sessions_routine_id_fkey'"),
                         "n|f|f")
        self.assertEqual(self.sql("select confdeltype, condeferrable, condeferred from pg_constraint "
                                  "where conrelid='gym_sets'::regclass and conname='gym_sets_session_id_fkey'"),
                         "c|f|f")
        self.assertEqual(self.sql("select attnotnull from pg_attribute where "
                                  "attrelid='gym_exercise_names'::regclass and attname='name'"), "t")
        self.sql("delete from gym_routines where id='routine_reapplication'")
        self.assertEqual(self.sql("select routine_id is null and history_routine_id='routine_reapplication' "
                                  "from gym_sessions where id='session_reapplication'"), "t")

    def test_post_adoption_deploy_preserves_every_catalog_object(self):
        self.apply("gym_sync.sql", "journal_sync.sql")
        self.sql("update gym_sessions set history_routine_id=null where id='session_reapplication'")
        before = self.snapshot()
        source = "select jsonb_build_object('row', to_jsonb(s), 'xmin', s.xmin::text) " \
                 "from gym_sessions s where id='session_reapplication' union all " \
                 "select jsonb_build_object('row', to_jsonb(p), 'xmin', p.xmin::text) from journal_page p"
        data = self.sql(source)
        result = self.deploy_schema(BACKEND / "db/schema.sql")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_catalog_equal(before, self.snapshot())
        self.assertEqual(data, self.sql(source))
        self.assertEqual(self.sql("select count(*) from pg_trigger where "
                                  "tgrelid='gym_sessions'::regclass and tgname='gym_session_routine_identity'"), "0")
        self.assertEqual(self.sql("select confdeltype, condeferrable, condeferred from pg_constraint "
                                  "where conrelid='gym_sessions'::regclass and conname='gym_sessions_routine_id_fkey'"),
                         "a|t|t")
        self.assertEqual(self.sql("select attnotnull from pg_attribute where "
                                  "attrelid='gym_exercise_names'::regclass and attname='name'"), "f")

    def test_deploy_refuses_origin_schema_before_adopted_database_changes(self):
        self.apply("gym_sync.sql", "journal_sync.sql")
        self.sql("update gym_sessions set history_routine_id=null where id='session_reapplication'")
        before = self.snapshot()
        rows = "select jsonb_build_object('row',to_jsonb(s),'xmin',s.xmin::text) from gym_sessions s " \
               "union all select jsonb_build_object('row',to_jsonb(p),'xmin',p.xmin::text) from journal_page p"
        data = self.sql(rows)
        origin_schema = self.origin_schema()
        self.assertNotIn("windmill-schema-adoption-compatibility:", origin_schema)
        with tempfile.TemporaryDirectory(prefix="wm-origin-schema-") as directory:
            schema = Path(directory) / "schema.sql"
            schema.write_text(origin_schema)
            result = self.deploy_schema(schema)
        self.assertNotEqual(result.returncode, 0, "origin/main schema was allowed onto an adopted database")
        self.assertIn("adoption-compatible", result.stderr)
        self.assert_catalog_equal(before, self.snapshot())
        self.assertEqual(data, self.sql(rows))

    def test_adopted_journal_reapply_preserves_added_not_null_constraints(self):
        self.apply("gym_sync.sql", "journal_sync.sql")
        self.sql("ALTER TABLE journal_page ALTER COLUMN mood SET NOT NULL; "
                 "ALTER TABLE journal_page ALTER COLUMN energy SET NOT NULL")
        before = self.snapshot()
        rows = "SELECT jsonb_build_object('row',to_jsonb(p),'xmin',p.xmin::text) FROM journal_page p"
        data = self.sql(rows)
        result = self.deploy_schema(BACKEND / "db/schema.sql")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_catalog_equal(before, self.snapshot())
        self.assertEqual(data, self.sql(rows))
        self.assertEqual(self.sql("SELECT attname,attnotnull FROM pg_attribute "
                                 "WHERE attrelid='journal_page'::regclass AND attname IN ('mood','energy') "
                                 "ORDER BY attname"), "energy|t\nmood|t")

    def test_final_schema_audit_rejects_origin_schema_even_with_compatible_declaration(self):
        self.sql("update gym_sessions set history_routine_id=null where id='session_reapplication'")
        origin_schema = self.origin_schema()
        result = self.run_rehearsal("-- windmill-schema-adoption-compatibility: gym-journal-v1\n" + origin_schema)
        self.assertNotEqual(result.returncode, 0, "final schema reapply silently undid gym adoption")
        self.assertIn("schema bootstrap rerun changed adopted gym/journal catalog", result.stderr)

    def test_migration_refuses_origin_schema_before_adoption(self):
        before = self.snapshot()
        data = self.sql("select jsonb_build_object('row',to_jsonb(s),'xmin',s.xmin::text) from gym_sessions s")
        origin_schema = self.origin_schema()
        result = self.run_rehearsal(origin_schema)
        self.assertNotEqual(result.returncode, 0, "migration accepted an undeclared origin/main schema")
        self.assertIn("adoption-compatible", result.stderr)
        self.assertEqual(self.sql("select to_regclass('gym_sync_adoptions') is null "
                                  "and to_regclass('journal_sync_adoptions') is null"), "t")
        self.assert_catalog_equal(before, self.snapshot())
        self.assertEqual(data, self.sql("select jsonb_build_object('row',to_jsonb(s),'xmin',s.xmin::text) from gym_sessions s"))

    def test_final_schema_audit_rechecks_gym_digest(self):
        schema = (BACKEND / "db/schema.sql").read_text() + "\n" \
                 "update sync_scopes set digest=decode(repeat('00',32),'hex') where key like '%/gym';\n"
        result = self.run_rehearsal(schema)
        self.assertNotEqual(result.returncode, 0, "final schema reapply invalidated an unchecked gym digest")
        self.assertIn("gym backfill: current feed digest or greatest seq mismatch", result.stderr)

    def test_legacy_image_without_schema_guard_accepts_unadopted_database(self):
        with tempfile.TemporaryDirectory(prefix="wm-legacy-runtime-") as directory:
            runtime = Path(directory)
            schema = runtime / "schema.sql"
            schema.write_text(self.origin_schema())
            result = self.deploy_schema(schema, runtime)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sql("select to_regclass('gym_sync_adoptions') is null "
                                  "and to_regclass('journal_sync_adoptions') is null"), "t")
        self.assertEqual(self.sql("select history_routine_id from gym_sessions "
                                  "where id='session_reapplication'"), "routine_reapplication")
        self.sql("delete from gym_routines where id='routine_reapplication'")
        self.assertEqual(self.sql("select routine_id is null and history_routine_id='routine_reapplication' "
                                  "from gym_sessions where id='session_reapplication'"), "t")

    def test_legacy_image_without_schema_guard_refuses_adopted_database(self):
        self.apply("gym_sync.sql", "journal_sync.sql")
        self.sql("update gym_sessions set history_routine_id=null where id='session_reapplication'")
        before = self.snapshot()
        rows = "select jsonb_build_object('row',to_jsonb(s),'xmin',s.xmin::text) from gym_sessions s " \
               "union all select jsonb_build_object('row',to_jsonb(p),'xmin',p.xmin::text) from journal_page p"
        data = self.sql(rows)
        with tempfile.TemporaryDirectory(prefix="wm-legacy-runtime-") as directory:
            runtime = Path(directory)
            schema = runtime / "schema.sql"
            schema.write_text(self.origin_schema())
            result = self.deploy_schema(schema, runtime)
        self.assertNotEqual(result.returncode, 0, "unguarded legacy runtime changed an adopted database")
        self.assertIn("adoption-compatible", result.stderr)
        self.assert_catalog_equal(before, self.snapshot())
        self.assertEqual(data, self.sql(rows))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--maintenance-db", default=SchemaReapplicationTest.maintenance)
    parser.add_argument("--bin-dir", type=Path, default=SchemaReapplicationTest.bin_dir)
    parser.add_argument("--origin-schema", type=Path)
    arguments, remaining = parser.parse_known_args()
    SchemaReapplicationTest.maintenance = arguments.maintenance_db
    SchemaReapplicationTest.bin_dir = arguments.bin_dir.resolve()
    SchemaReapplicationTest.legacy_schema = arguments.origin_schema
    unittest.main(argv=[__file__, *remaining])
