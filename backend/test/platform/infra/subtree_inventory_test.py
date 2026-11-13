import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


TOOL = sys.argv.pop(1)
SCHEMA = sys.argv.pop(1)
WRITE = re.compile(rb'write (\{[^\n]*\}) - ')
FAILED = b"The subtree inventory could not be read.\n"
UNCONFIGURED = b"The subtree inventory needs DATABASE_URL.\n"

MINE = "aaaaaaaa-0000-4000-8000-00000000000a"
THEIRS = "bbbbbbbb-0000-4000-8000-00000000000b"


def tree(n):
    return f"t_aa{n:014x}"


THEIR_TREE = "t_bb00000000000001"
NOBODYS_TREE = "t_cc00000000000001"
MISSING = "t_ff00000000000001"
FREE_TEXT = "learn the cello"

# (id, owner, deleted, title) and (tree, node, opens, present): every class the inventory counts, a step of a deleted
# node, a step of a deleted tree and a tree nobody owns, none of which it counts.
TREES = [
    *[(tree(n), MINE, False, f"Chain tree {n}") for n in range(1, 6)],
    (tree(6), MINE, False, "Bare root"),
    (tree(7), MINE, False, "Opens one tree twice"),
    (tree(8), MINE, False, "Opened twice from one tree"),
    (tree(9), MINE, False, "First opener"),
    (tree(10), MINE, False, "Second opener"),
    (tree(11), MINE, False, "Opened from two trees"),
    (tree(12), MINE, False, "Opens itself"),
    (tree(13), MINE, False, "Pair one"),
    (tree(14), MINE, False, "Pair two"),
    *[(tree(n), MINE, False, f"Ring tree {n}") for n in range(16, 20)],
    (tree(20), MINE, False, "Points nowhere"),
    (tree(21), MINE, True, "Deleted tree"),
    (THEIR_TREE, THEIRS, False, "Their tree"),
    (NOBODYS_TREE, None, False, "Nobody's tree"),
]
STEPS = [
    *[(tree(n), f"down-{n}", tree(n + 1), True) for n in range(1, 5)],
    (tree(7), "twice-1", tree(8), True),
    (tree(7), "twice-2", tree(8), True),
    (tree(9), "first", tree(11), True),
    (tree(10), "second", tree(11), True),
    (tree(12), "itself", tree(12), True),
    (tree(13), "to-two", tree(14), True),
    (tree(14), "to-one", tree(13), True),
    *[(tree(n), f"ring-{n}", tree(16 + (n - 15) % 4), True) for n in range(16, 20)],
    (tree(20), "at-missing", MISSING, True),
    (tree(20), "at-deleted", tree(21), True),
    (tree(20), "at-theirs", THEIR_TREE, True),
    (tree(20), "at-free-text", FREE_TEXT, True),
    (tree(20), "deleted-step", tree(6), False),
    (tree(20), "plain", "", True),
    (tree(21), "from-a-deleted-tree", tree(6), True),
    (THEIR_TREE, "at-mine", tree(1), True),
    (NOBODYS_TREE, "at-mine", tree(6), True),
]
EXPECTED = {
    "trees": 21,
    "roots": 7,
    "owned": 4,
    "multiOpened": {"trees": 2, "sameTree": 1, "acrossTrees": 1, "maxOpeners": 2},
    "cycles": {"trees": 7, "selfPointers": 1, "loops": {"1": 1, "2": 1, "3-8": 1, "9+": 0}},
    "dangling": {"missing": 1, "deleted": 1, "foreign": 2, "notATreeId": 1},
    "depth": {"deepest": 4, "1": 1, "2": 1, "3": 1, "4+": 1},
    "accounts": {"withPointers": 2, "needingChoice": 2},
}


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "true" if value else "false"
    return "'" + value.replace("'", "''") + "'"


def psql(url, *arguments, sql=None):
    return subprocess.run(["psql", url, "-XAtq", "-v", "ON_ERROR_STOP=1", *arguments], input=sql, text=True,
                          capture_output=True, check=True, timeout=120).stdout


class ToolTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="subtree-inventory-")
        self.addCleanup(directory.cleanup)
        self.env = {**os.environ, "SENTRY_DSN": "", "PGCONNECT_TIMEOUT": "1",
                    "WINDMILL_LOG_EMERGENCY_FILE": str(Path(directory.name) / "emergency.log")}

    def invoke(self, env):
        return subprocess.run([TOOL], capture_output=True, env=env, timeout=60)

    def completion(self, result, outcome):
        records = [json.loads(match) for match in WRITE.findall(result.stderr)]
        self.assertEqual(len(records), 1, result.stderr.decode())
        record = records[0]
        self.assertEqual((record["operation"], record["product"], record["door"], record["outcome"]),
                         ("roadmap.subtree.inventory", "roadmap", "tool", outcome))


class FailureTest(ToolTest):
    def test_without_a_database_url_it_says_so_in_one_fixed_sentence_and_prints_nothing(self):
        for value in (None, ""):
            env = dict(self.env)
            env.pop("DATABASE_URL", None)
            if value is not None:
                env["DATABASE_URL"] = value
            with self.subTest(value=value):
                result = self.invoke(env)
                self.assertEqual(result.returncode, 2, result.stderr.decode())
                self.assertEqual(result.stdout, b"")
                self.assertIn(UNCONFIGURED, result.stderr)
                self.completion(result, "configuration-unavailable")

    def test_an_unreachable_database_fails_in_one_fixed_sentence_without_its_credentials(self):
        env = {**self.env, "DATABASE_URL": "postgresql://PRIVATE_USER:PRIVATE_PASSWORD@/PRIVATE_DATABASE"
               "?host=/nonexistent/private-socket"}
        result = self.invoke(env)
        self.assertEqual(result.returncode, 1, result.stderr.decode())
        self.assertEqual(result.stdout, b"")
        self.assertIn(FAILED, result.stderr)
        self.completion(result, "failed")
        for private in ("PRIVATE_USER", "PRIVATE_PASSWORD", "PRIVATE_DATABASE", "private-socket"):
            self.assertNotIn(private.encode(), result.stderr)


@unittest.skipUnless(os.environ.get("WM_PG_TEST"), "SKIP: set WM_PG_TEST and DATABASE_URL for Postgres cases")
class InventoryTest(ToolTest):
    # The tool reads the whole database, so it runs on one of its own that holds the fixture alone.
    @classmethod
    def setUpClass(cls):
        maintenance = os.environ.get("DATABASE_URL")
        if not maintenance:
            raise unittest.SkipTest("WM_PG_TEST requires DATABASE_URL")
        database = f"wm_subtree_inventory_{os.getpid()}"
        psql(maintenance, "-c", f'DROP DATABASE IF EXISTS "{database}"')
        psql(maintenance, "-c", f'CREATE DATABASE "{database}"')
        cls.addClassCleanup(psql, maintenance, "-c", f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        cls.url = re.sub(r"^(postgres(?:ql)?://[^/?]*)/[^?]*", rf"\1/{database}", maintenance)
        if cls.url == maintenance:
            raise AssertionError("DATABASE_URL names no database to replace")
        psql(cls.url, "-f", SCHEMA)
        rows = [f"INSERT INTO trees (id, title, owner_id, deleted_at) VALUES ({literal(id)}, {literal(title)}, "
                f"{literal(owner)}::uuid, {'now()' if deleted else 'NULL'});" for id, owner, deleted, title in TREES]
        rows += [f"INSERT INTO tree_nodes (tree_id, node_id, created_hlc, label, opens, opens_hlc, present) VALUES "
                 f"({literal(tree_id)}, {literal(node)}, '1:0:r_a', 'Step', {literal(opens)}, '1:0:r_a', "
                 f"{literal(present)});" for tree_id, node, opens, present in STEPS]
        psql(cls.url, sql="\n".join(rows))

    def snapshot(self):
        return psql(self.url, "-c", "SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM trees t",
                    "-c", "SELECT md5(string_agg(n::text, ',' ORDER BY tree_id, node_id)) FROM tree_nodes n")

    def test_it_prints_every_count_as_one_json_line_and_names_no_tree_account_or_title(self):
        before = self.snapshot()
        result = self.invoke({**self.env, "DATABASE_URL": self.url})
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout.count(b"\n"), 1)
        self.assertEqual(json.loads(result.stdout), EXPECTED)
        self.completion(result, "ok")
        named = {MINE, THEIRS, MISSING, FREE_TEXT, "r_a"}
        for id, owner, deleted, title in TREES:
            named |= {id, title}
        for tree_id, node, opens, present in STEPS:
            named |= {node} | ({opens} if opens else set())
        for name in named:
            with self.subTest(name=name):
                self.assertNotIn(name.encode(), result.stdout)
                self.assertNotIn(name.encode(), result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_it_answers_the_same_where_every_transaction_is_read_only(self):
        env = {**self.env, "DATABASE_URL": self.url, "PGOPTIONS": "-c default_transaction_read_only=on"}
        result = self.invoke(env)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), EXPECTED)


if __name__ == "__main__":
    unittest.main(verbosity=2)
