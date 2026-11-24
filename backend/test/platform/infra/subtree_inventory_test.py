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
NOT_TAKEN = b"The subtree inventory was counted, and stdout did not take the counts.\n"
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
    "hanging": 0,
    "multiOpened": {"trees": 2, "sameTree": 1, "acrossTrees": 1, "maxOpeners": 2},
    "cycles": {"trees": 7, "selfPointers": 1, "alsoMultiOpened": 0, "loops": {"1": 1, "2": 1, "3-8": 1, "9+": 0},
               "byEntries": {"0": 3, "1": 0, "2+": 0}},
    "dangling": {"missing": 1, "deleted": 1, "foreign": 2, "notATreeId": 1},
    "depth": {"deepest": 4, "1": 1, "2": 1, "3": 1, "4+": 1},
    "depthIfResolved": {"deepest": 4, "1": 5, "2": 1, "3": 5, "4+": 1},
    "accounts": {"withPointers": 2, "needingChoice": 2},
    "engine": {
        "visibility": {
            account: {place: {"private": 0, "unlisted": 0, "public": 0, "unset": 0, "other": 0}
                      for place in ("roots", "subtrees")}
            for account in ("house", "people")},
        "pointersWithoutOpens": {"restore": 0, "clientPut": 0}},
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


# The tool reads the whole database, so each class runs it on one of its own that holds `sql` alone.
def own_database(test_class, name, sql):
    maintenance = os.environ.get("DATABASE_URL")
    if not maintenance:
        raise unittest.SkipTest("WM_PG_TEST requires DATABASE_URL")
    database = f"wm_subtree_inventory_{name}_{os.getpid()}"
    psql(maintenance, "-c", f'DROP DATABASE IF EXISTS "{database}"')
    psql(maintenance, "-c", f'CREATE DATABASE "{database}"')
    test_class.addClassCleanup(psql, maintenance, "-c", f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
    url = re.sub(r"^(postgres(?:ql)?://[^/?]*)/[^?]*", rf"\1/{database}", maintenance)
    if url == maintenance:
        raise AssertionError("DATABASE_URL names no database to replace")
    psql(url, "-f", SCHEMA)
    psql(url, sql=sql)
    return url


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
    @classmethod
    def setUpClass(cls):
        rows = [f"INSERT INTO trees (id, title, owner_id, deleted_at) VALUES ({literal(id)}, {literal(title)}, "
                f"{literal(owner)}::uuid, {'now()' if deleted else 'NULL'});" for id, owner, deleted, title in TREES]
        rows += [f"INSERT INTO tree_nodes (tree_id, node_id, created_hlc, label, opens, opens_hlc, present) VALUES "
                 f"({literal(tree_id)}, {literal(node)}, '1:0:r_a', 'Step', {literal(opens)}, '1:0:r_a', "
                 f"{literal(present)});" for tree_id, node, opens, present in STEPS]
        cls.url = own_database(cls, "fixture", "\n".join(rows))

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

    def test_a_stdout_that_takes_nothing_fails_saying_so_and_not_that_the_read_failed(self):
        result = subprocess.run([TOOL], stdout=None, stderr=subprocess.PIPE, env={**self.env, "DATABASE_URL": self.url},
                                timeout=60, preexec_fn=lambda: os.close(1))
        self.assertEqual(result.returncode, 1, result.stderr.decode())
        self.assertIn(NOT_TAKEN, result.stderr)
        self.assertNotIn(FAILED, result.stderr)
        self.completion(result, "failed")

    def test_it_answers_the_same_where_every_transaction_is_read_only(self):
        env = {**self.env, "DATABASE_URL": self.url, "PGOPTIONS": "-c default_transaction_read_only=on"}
        result = self.invoke(env)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), EXPECTED)


# The engine's roadmap tables alone: each filled bucket holds a number no other bucket of its object holds, and the
# house's differ from people's bucket by bucket, so none can be read for another. Rows the tool leaves out stand beside.
@unittest.skipUnless(os.environ.get("WM_PG_TEST"), "SKIP: set WM_PG_TEST and DATABASE_URL for Postgres cases")
class EngineCountsTest(ToolTest):
    @classmethod
    def setUpClass(cls):
        house = "00000000-0000-4000-8000-00000000d3e0"
        client = "r_a1b2c3d4e5f6"
        client_ending_in_srv = "r_a1b2c3d4esrv"
        # (count, owner, alive, subtree, meta): `count` roadmaps alike, a subtree under its owner's first roadmap;
        # meta is (visibility, reach), None where the roadmap's tree scope holds none.
        groups = [
            (2, MINE, True, False, ("private", "private")),
            (1, MINE, True, False, ("private", "public")),
            (1, MINE, True, False, ("unlisted", "unlisted")),
            (1, THEIRS, True, False, ("unlisted", "unlisted")),
            (4, MINE, True, False, ("public", "public")),
            (1, MINE, True, False, None),
            (4, MINE, True, False, (None, None)),
            (1, MINE, True, False, ("secret", "secret")),
            (2, MINE, True, True, (None, "private")),
            (3, MINE, True, True, (None, "unlisted")),
            (1, THEIRS, True, True, (None, "public")),
            (2, house, True, False, ("private", "private")),
            (1, house, True, False, ("unlisted", "unlisted")),
            (3, house, True, False, ("public", "public")),
            (4, house, True, False, (None, None)),
            (5, house, True, False, ("secret", "secret")),
            (1, house, True, True, (None, "private")),
            (2, house, True, True, (None, "unlisted")),
            (3, house, True, True, (None, "public")),
            (1, MINE, False, False, ("unlisted", "unlisted")),
            (1, MINE, False, True, (None, "unlisted")),
            (1, house, False, False, ("public", "public")),
        ]
        roadmaps, first = [], {}
        for count, owner, alive, subtree, meta in groups:
            for _ in range(count):
                id = f"t_ee{len(roadmaps) + 1:014x}"
                first.setdefault(owner, id)
                roadmaps.append((id, owner, alive, first[owner] if subtree else None, meta))
        cls.roadmaps = roadmaps
        mine = [id for id, owner, alive, parent, meta in roadmaps if owner == MINE and alive and not parent]
        theirs = next(id for id, owner, alive, parent, meta in roadmaps if owner == THEIRS)
        gone = next(id for id, owner, alive, parent, meta in roadmaps if owner == MINE and not alive)
        # (roadmap, account, step, life, the life stamp's actor, opens)
        cls.pointers = [
            (mine[0], MINE, "undone-in-mine", "alive", "srv", None),
            (theirs, THEIRS, "undone-in-theirs", "alive", "srv", None),
            (mine[0], MINE, "put-again-1", "alive", client, None),
            (mine[1], MINE, "put-again-2", "alive", client_ending_in_srv, None),
            (mine[2], MINE, "put-again-3", "alive", client_ending_in_srv, None),
            (mine[0], MINE, "restored-whole", "alive", "srv", mine[3]),
            (mine[1], MINE, "put-whole", "alive", client, mine[3]),
            (mine[1], MINE, "cleared", "dead", client, None),
            (gone, MINE, "in-a-deleted-roadmap", "alive", client, None),
        ]
        cls.named = {MINE, THEIRS, house, client, client_ending_in_srv, "secret", "holder", "mine@example.test",
                     "theirs@example.test", "house@windmill.invalid"}
        cls.named |= {id for id, *rest in roadmaps}
        cls.named |= {step for tree, account, step, *rest in cls.pointers}
        alive = {id: living for id, owner, living, parent, meta in roadmaps}
        stamp = f"'1:0:{client}'"
        rows = [f"INSERT INTO users (id, email) VALUES ({literal(MINE)}, 'mine@example.test'), "
                f"({literal(THEIRS)}, 'theirs@example.test'), ({literal(house)}, 'house@windmill.invalid');"]
        rows += [f"INSERT INTO sync_scopes (key, kind, owner) VALUES ('acct:{account}/roadmap', 'product', "
                 f"{literal(account)}::uuid);" for account in (MINE, THEIRS, house)]
        rows += [f"INSERT INTO sync_scopes (key, kind, owner, state, dead_at) VALUES ('tree:{id}', 'tree', "
                 f"{literal(owner)}::uuid, {literal('alive' if living else 'dead')}, {'NULL' if living else '1'});"
                 for id, owner, living, parent, meta in roadmaps]
        rows += [f"INSERT INTO sync_scopes (key, kind, owner, state, dead_at) VALUES ('acct:{account}/overlay/{tree}', "
                 f"'overlay', {literal(account)}::uuid, {literal('alive' if alive[tree] else 'dead')}, "
                 f"{'NULL' if alive[tree] else '1'});"
                 for tree, account in sorted({(tree, account) for tree, account, *rest in cls.pointers})]
        rows += [f"INSERT INTO roadmap_trees (scope_key, id, seq, rc, ru, born, life, life_stamp, parent) VALUES "
                 f"('acct:{owner}/roadmap', {literal(id)}, 1, 1, 1, {stamp}, {literal('alive' if living else 'dead')}, "
                 f"{stamp}, {literal(json.dumps({'tree': parent, 'step': 'holder'}) if parent else None)});"
                 for id, owner, living, parent, meta in roadmaps]
        rows += [f"INSERT INTO roadmap_metas (scope_key, id, seq, rc, ru, visibility, visibility_stamp, reach, "
                 f"reach_stamp) VALUES ('tree:{id}', 'meta', 1, 1, 1, {literal(meta[0])}, "
                 f"{stamp if meta[0] else 'NULL'}, {literal(meta[1])}, {stamp if meta[1] else 'NULL'});"
                 for id, owner, living, parent, meta in roadmaps if meta]
        rows += [f"INSERT INTO roadmap_pointers (scope_key, id, seq, rc, ru, life, life_stamp, opens, opens_stamp) "
                 f"VALUES ('acct:{account}/overlay/{tree}', {literal(step)}, 1, 1, 1, {literal(life)}, '5:0:{actor}', "
                 f"{literal(opens)}, {stamp if opens else 'NULL'});"
                 for tree, account, step, life, actor, opens in cls.pointers]
        cls.url = own_database(cls, "engine", "\n".join(rows))

    def snapshot(self):
        return psql(self.url,
                    "-c", "SELECT md5(string_agg(s::text, ',' ORDER BY key)) FROM sync_scopes s",
                    "-c", "SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM roadmap_trees t",
                    "-c", "SELECT md5(string_agg(m::text, ',' ORDER BY scope_key)) FROM roadmap_metas m",
                    "-c", "SELECT md5(string_agg(p::text, ',' ORDER BY scope_key, id)) FROM roadmap_pointers p")

    def test_it_counts_every_alive_roadmap_by_owner_and_visibility_and_every_pointer_without_opens_by_door(self):
        before = self.snapshot()
        for options in ("", "-c default_transaction_read_only=on"):
            with self.subTest(options=options):
                result = self.invoke({**self.env, "DATABASE_URL": self.url, "PGOPTIONS": options})
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(result.stdout.count(b"\n"), 1)
                self.assertEqual(json.loads(result.stdout), {
                    "trees": 0,
                    "roots": 0,
                    "owned": 0,
                    "hanging": 0,
                    "multiOpened": {"trees": 0, "sameTree": 0, "acrossTrees": 0, "maxOpeners": 0},
                    "cycles": {"trees": 0, "selfPointers": 0, "alsoMultiOpened": 0,
                               "loops": {"1": 0, "2": 0, "3-8": 0, "9+": 0}, "byEntries": {"0": 0, "1": 0, "2+": 0}},
                    "dangling": {"missing": 0, "deleted": 0, "foreign": 0, "notATreeId": 0},
                    "depth": {"deepest": 0, "1": 0, "2": 0, "3": 0, "4+": 0},
                    "depthIfResolved": {"deepest": 0, "1": 0, "2": 0, "3": 0, "4+": 0},
                    "accounts": {"withPointers": 0, "needingChoice": 0},
                    "engine": {
                        "visibility": {
                            "house": {
                                "roots": {"private": 2, "unlisted": 1, "public": 3, "unset": 4, "other": 5},
                                "subtrees": {"private": 1, "unlisted": 2, "public": 3, "unset": 0, "other": 0}},
                            "people": {
                                "roots": {"private": 3, "unlisted": 2, "public": 4, "unset": 5, "other": 1},
                                "subtrees": {"private": 2, "unlisted": 3, "public": 1, "unset": 0, "other": 0}}},
                        "pointersWithoutOpens": {"restore": 2, "clientPut": 3}},
                })
                self.completion(result, "ok")
                for name in self.named:
                    self.assertNotIn(name.encode(), result.stdout, name)
                    self.assertNotIn(name.encode(), result.stderr, name)
        self.assertEqual(self.snapshot(), before)


# A chain of 200,001 trees whose last two open each other. Each tree opens the one before it in id order, so the walk
# for loops, which starts from the first id and climbs to each tree's openers, has the whole chain to climb at once.
@unittest.skipUnless(os.environ.get("WM_PG_TEST"), "SKIP: set WM_PG_TEST and DATABASE_URL for Postgres cases")
class LongChainTest(ToolTest):
    @classmethod
    def setUpClass(cls):
        tree = "'t_' || lpad(to_hex(k), 16, '0')"
        cls.url = own_database(cls, "chain", f"""
            INSERT INTO trees (id, title, owner_id) SELECT {tree}, 'Chain', {literal(MINE)}::uuid
            FROM generate_series(0, 200000) k;
            INSERT INTO tree_nodes (tree_id, node_id, created_hlc, label, opens, opens_hlc, present)
            SELECT {tree}, 'next', '1:0:r_a', 'Step',
                   't_' || lpad(to_hex(CASE WHEN k = 0 THEN 1 ELSE k - 1 END), 16, '0'), '1:0:r_a', true
            FROM generate_series(0, 200000) k;""")

    def test_a_chain_of_two_hundred_thousand_trees_is_counted_to_its_end(self):
        result = self.invoke({**self.env, "DATABASE_URL": self.url})
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout), {
            "trees": 200001,
            "roots": 1,
            "owned": 199998,
            "hanging": 0,
            "multiOpened": {"trees": 0, "sameTree": 0, "acrossTrees": 0, "maxOpeners": 0},
            "cycles": {"trees": 2, "selfPointers": 0, "alsoMultiOpened": 1, "loops": {"1": 0, "2": 1, "3-8": 0, "9+": 0},
                       "byEntries": {"0": 0, "1": 1, "2+": 0}},
            "dangling": {"missing": 0, "deleted": 0, "foreign": 0, "notATreeId": 0},
            "depth": {"deepest": 199998, "1": 1, "2": 1, "3": 1, "4+": 199995},
            "depthIfResolved": {"deepest": 200000, "1": 1, "2": 1, "3": 1, "4+": 199997},
            "accounts": {"withPointers": 1, "needingChoice": 1},
            "engine": {
                "visibility": {
                    account: {place: {"private": 0, "unlisted": 0, "public": 0, "unset": 0, "other": 0}
                              for place in ("roots", "subtrees")}
                    for account in ("house", "people")},
                "pointersWithoutOpens": {"restore": 0, "clientPut": 0}},
        })


if __name__ == "__main__":
    unittest.main(verbosity=2)
