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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--maintenance-db", default=SchemaReapplicationTest.maintenance)
    arguments, remaining = parser.parse_known_args()
    SchemaReapplicationTest.maintenance = arguments.maintenance_db
    unittest.main(argv=[__file__, *remaining])
