import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


TOOL = sys.argv.pop(1)
SERVER = sys.argv.pop(1)
SCHEMA = sys.argv.pop(1)
WRITE = re.compile(rb'write (\{[^\n]*\}) - ')
USAGE = b"usage: windmill_roadmaps_to_private [--write], with DATABASE_URL set\n"
FAILED = (b"The move of unlisted roadmaps to private stopped before its end: what it moved stays private, and a run again "
          b"moves the rest.\n")
HOUSE = "00000000-0000-4000-8000-00000000d3e0"


def psql(url, *arguments, sql=None):
    return subprocess.run(["psql", url, "-XAtq", "-v", "ON_ERROR_STOP=1", *arguments], input=sql, text=True,
                          capture_output=True, check=True, timeout=120).stdout


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class ToolTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="roadmaps-to-private-")
        self.addCleanup(directory.cleanup)
        self.env = {**os.environ, "SENTRY_DSN": "", "PGCONNECT_TIMEOUT": "1", "ROADMAP_ENGINE_ENABLED": "1",
                    "WINDMILL_LOG_EMERGENCY_FILE": str(Path(directory.name) / "emergency.log")}

    def invoke(self, env, *arguments):
        return subprocess.run([TOOL, *arguments], capture_output=True, env=env, timeout=120)

    def lines(self, result):
        return [json.loads(match) for match in WRITE.findall(result.stderr)]

    def completion(self, result, outcome):
        self.assertEqual([(line["operation"], line["product"], line["door"], line["outcome"]) for line in self.lines(result)],
                         [("roadmap.unlisted.to_private", "roadmap", "tool", outcome)], result.stderr.decode())


class FailureTest(ToolTest):
    def test_without_a_database_url_it_says_its_usage_and_prints_nothing(self):
        for value in (None, ""):
            env = dict(self.env)
            env.pop("DATABASE_URL", None)
            if value is not None:
                env["DATABASE_URL"] = value
            with self.subTest(value=value):
                result = self.invoke(env, "--write")
                self.assertEqual(result.returncode, 2, result.stderr.decode())
                self.assertEqual(result.stdout, b"")
                self.assertIn(USAGE, result.stderr)
                self.completion(result, "configuration-unavailable")

    def test_an_argument_other_than_write_is_refused_before_anything_is_read(self):
        env = {**self.env, "DATABASE_URL": "postgresql://PRIVATE_USER@/PRIVATE_DATABASE?host=/nonexistent/private-socket"}
        for arguments in (("--dry-run",), ("--write", "--write"), ("write",)):
            with self.subTest(arguments=arguments):
                result = self.invoke(env, *arguments)
                self.assertEqual(result.returncode, 2, result.stderr.decode())
                self.assertEqual(result.stdout, b"")
                self.assertIn(USAGE, result.stderr)
                self.completion(result, "usage")

    def test_an_unreachable_database_fails_in_one_fixed_sentence_without_its_credentials(self):
        env = {**self.env, "DATABASE_URL": "postgresql://PRIVATE_USER:PRIVATE_PASSWORD@/PRIVATE_DATABASE"
               "?host=/nonexistent/private-socket"}
        for arguments in ((), ("--write",)):
            with self.subTest(arguments=arguments):
                result = self.invoke(env, *arguments)
                self.assertEqual(result.returncode, 1, result.stderr.decode())
                self.assertEqual(result.stdout, b"")
                self.assertIn(FAILED, result.stderr)
                self.completion(result, "failed")
                for private in ("PRIVATE_USER", "PRIVATE_PASSWORD", "PRIVATE_DATABASE", "private-socket"):
                    self.assertNotIn(private.encode(), result.stderr)


# The real server on a database of its own serves roadmap through the engine, and every roadmap is made by its owner's
# pushes, so every row the tool reads and writes is one the engine made, but for one root's reach, which the seed sets
# unlisted under its private visibility by hand. The tool then runs beside the server, as it does inside production's
# server container, and the server's pulls read its writes back.
@unittest.skipUnless(os.environ.get("WM_PG_TEST"), "SKIP: set WM_PG_TEST and DATABASE_URL for Postgres cases")
class MoveTest(ToolTest):
    @classmethod
    def setUpClass(cls):
        maintenance = os.environ.get("DATABASE_URL")
        if not maintenance:
            raise unittest.SkipTest("WM_PG_TEST requires DATABASE_URL")
        database = f"wm_roadmaps_to_private_{os.getpid()}"
        psql(maintenance, "-c", f'DROP DATABASE IF EXISTS "{database}"')
        psql(maintenance, "-c", f'CREATE DATABASE "{database}"')
        cls.addClassCleanup(psql, maintenance, "-c", f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        cls.url = re.sub(r"^(postgres(?:ql)?://[^/?]*)/[^?]*", rf"\1/{database}", maintenance)
        if cls.url == maintenance:
            raise AssertionError("DATABASE_URL names no database to replace")
        psql(cls.url, "-f", SCHEMA)
        cls.start_server()
        cls.seed()

    @classmethod
    def start_server(cls):
        cls.port = free_port()
        cls.log = tempfile.NamedTemporaryFile(prefix="roadmaps-to-private-server-", suffix=".log", delete=False)
        cls.addClassCleanup(cls.log.close)
        cls.server = subprocess.Popen([SERVER], stdout=cls.log, stderr=subprocess.STDOUT, env={
            "PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/"), "DATABASE_URL": cls.url,
            "PORT": str(cls.port), "WINDMILL_HOST": "127.0.0.1", "ROADMAP_ENGINE_ENABLED": "1"})

        def stop():
            if cls.server.poll() is None:
                cls.server.kill()
            cls.server.wait(timeout=30)
        cls.addClassCleanup(stop)
        until = time.time() + 120
        while time.time() < until:
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.5).close()
                break
            except OSError:
                if cls.server.poll() is not None:
                    raise AssertionError(f"the server ended before it listened; its log is {cls.log.name}")
                time.sleep(0.1)
        else:
            raise AssertionError(f"the server did not listen within 120 s; its log is {cls.log.name}")
        cls.schema = str(cls.ask("GET", "/v1/sync/hello", None, schema=2147483647)["schema"])

    @classmethod
    def ask(cls, method, path, secret, body=None, schema=None):
        connection = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=30)
        headers = {"Content-Type": "application/json", "Sync-Schema": str(schema or cls.schema)}
        if secret:
            headers["Authorization"] = f"Bearer {secret}"
        connection.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
        response = connection.getresponse()
        answer = json.loads(response.read())
        connection.close()
        if response.status != 200:
            raise AssertionError(f"{method} {path} answered {response.status}: {answer}")
        return answer

    # An account with a session and one replica, whose stamps tick on the wall clock.
    @classmethod
    def account(cls, id, email):
        secret = "roadmaps-to-private-" + uuid.uuid4().hex
        psql(cls.url, "-c", f"INSERT INTO users (id, email) VALUES ('{id}', '{email}')")
        psql(cls.url, "-c", f"INSERT INTO sessions (token_hash, user_id, expires_ms) VALUES "
             f"('{hashlib.sha256(secret.encode()).hexdigest()}', '{id}', (extract(epoch from now()) * 1000)::bigint + 3600000)")
        return {"id": id, "secret": secret, "replica": "rp_" + uuid.uuid4().hex, "n": 0, "actor": "a_" + uuid.uuid4().hex[:12],
                "counter": 0}

    @classmethod
    def push(cls, account, scope, delta=None, cmd=None):
        account["counter"] += 1
        stamp = f"{int(time.time() * 1000)}:{account['counter']}:{account['actor']}"
        account["n"] += 1
        intent = {"n": account["n"], "scope": scope}
        if delta is not None:
            intent["d"] = [json.loads(json.dumps(delta).replace('"STAMP"', json.dumps(stamp)))]
        if cmd is not None:
            intent["cmd"] = cmd
        answer = cls.ask("POST", "/v1/sync/push", account["secret"], {
            "replica": account["replica"], "account": account["id"], "ackThrough": account["n"] - 1, "intents": [intent]})
        result = answer["results"][0]
        if result["s"] != "ok":
            raise AssertionError(f"a seeding push was refused: {result}")

    # A root whose owner made it and chose its visibility, with a subtree under each of its `steps`.
    @classmethod
    def roadmap(cls, owner, visibility, title, *, steps=(), parent=None):
        tree = "t_" + uuid.uuid4().hex[:16]
        if parent:
            holder, step = parent
            cls.push(owner, "self/roadmap", cmd={"name": "roadmap.createSubtree", "args": {
                "tree": holder, "root": cls.roots[holder], "step": step, "subtree": tree}})
            cls.roots[tree] = cls.roots[holder]
        else:
            cls.push(owner, "self/roadmap", {"t": "tree", "id": tree, "born": "STAMP", "life": ["alive", "STAMP"]})
            cls.push(owner, f"tree/{tree}", {"t": "meta", "id": "meta", "f": {"title": [title, "STAMP"],
                                                                              "visibility": [visibility, "STAMP"]}})
            cls.roots[tree] = tree
        for step in steps:
            cls.push(owner, f"tree/{tree}", {"t": "node", "id": step, "born": "STAMP", "life": ["alive", "STAMP"],
                                             "f": {"label": [f"{title}, {step}", "STAMP"]}})
        cls.named |= {tree, title, *steps}
        return tree

    @classmethod
    def seed(cls):
        cls.roots, cls.named = {}, set()
        mine = cls.account(str(uuid.uuid4()), "mine@example.test")
        theirs = cls.account(str(uuid.uuid4()), "theirs@example.test")
        house = cls.account(HOUSE, "house@windmill.invalid")
        cls.reader = cls.account(str(uuid.uuid4()), "reader@example.test")
        cls.mine = mine
        cls.unlisted = cls.roadmap(mine, "unlisted", "Learn the cello", steps=("step-bowing",))
        cls.subtree = cls.roadmap(mine, None, "Bowing", steps=("step-spiccato",), parent=(cls.unlisted, "step-bowing"))
        cls.deeper = cls.roadmap(mine, None, "Spiccato", parent=(cls.subtree, "step-spiccato"))
        cls.bare = cls.roadmap(mine, "unlisted", "Bake bread")
        cls.private = cls.roadmap(mine, "private", "Run a marathon")
        cls.reach_only = cls.roadmap(mine, "private", "Learn to juggle")
        psql(cls.url, "-c", f"UPDATE roadmap_metas SET reach = 'unlisted' WHERE scope_key = 'tree:{cls.reach_only}' AND id = 'meta'")
        cls.public = cls.roadmap(mine, "public", "Grow tomatoes", steps=("step-soil",))
        cls.under_public = cls.roadmap(mine, None, "Soil", parent=(cls.public, "step-soil"))
        cls.deleted = cls.roadmap(mine, "unlisted", "Learn Welsh")
        cls.push(mine, "self/roadmap", {"t": "tree", "id": cls.deleted, "born": cls.born(cls.deleted), "life": ["dead", "STAMP"]})
        cls.theirs = cls.roadmap(theirs, "unlisted", "Paint birds")
        cls.house = cls.roadmap(house, "unlisted", "The demo", steps=("step-start",))
        cls.under_house = cls.roadmap(house, None, "Start", parent=(cls.house, "step-start"))
        cls.moved = {cls.unlisted, cls.subtree, cls.deeper, cls.bare, cls.theirs}
        cls.named |= {account[field] for account in (mine, theirs, house, cls.reader) for field in ("id", "replica", "actor")}
        cls.named |= {"mine@example.test", "theirs@example.test", "house@windmill.invalid", "reader@example.test"}

    @classmethod
    def born(cls, tree):
        return psql(cls.url, "-c", f"SELECT born FROM roadmap_trees WHERE id = '{tree}'").strip()

    def metas(self):
        rows = psql(self.url, "-F", "\t", "-c", "SELECT substr(scope_key, 6), visibility, visibility_stamp, reach, "
                    "reach_stamp, md5(m::text) FROM roadmap_metas m WHERE id = 'meta'")
        return {line.split("\t")[0]: line.split("\t")[1:] for line in rows.splitlines()}

    def snapshot(self):
        return psql(self.url,
                    "-c", "SELECT md5(string_agg(s::text, ',' ORDER BY key)) FROM sync_scopes s",
                    "-c", "SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM roadmap_trees t",
                    "-c", "SELECT md5(string_agg(m::text, ',' ORDER BY scope_key)) FROM roadmap_metas m",
                    "-c", "SELECT md5(string_agg(n::text, ',' ORDER BY scope_key, id)) FROM roadmap_nodes n",
                    "-c", "SELECT count(*) FROM sync_requests")

    # A replica's pull of one scope to its end: every row the pages carried, and the cursor it would pull from next.
    def pull(self, account, scope, cursor=None):
        rows = []
        while True:
            page = self.ask("POST", "/v1/sync/pull", account["secret"], {"scopes": [{"scope": scope, "cursor": cursor}]})["pages"][0]
            if page["kind"] != "rows":
                return page["kind"], rows, cursor
            rows += page["rows"]
            cursor = page["cursor"]
            if not page["more"]:
                return "rows", rows, cursor

    def run_tool(self, *arguments):
        result = self.invoke({**self.env, "DATABASE_URL": self.url}, *arguments)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout.count(b"\n"), 1)
        for name in self.named:
            self.assertNotIn(name.encode(), result.stdout, name)
            self.assertNotIn(name.encode(), result.stderr, name)
        return json.loads(result.stdout), [(line["operation"], line["door"], line["outcome"], line.get("refused"))
                                           for line in self.lines(result)]

    def test_a_dry_run_writes_nothing_and_writes_move_each_people_s_unlisted_root_once_a_busy_one_on_a_run_again(self):
        counted = lambda people, house: {"people": {"roots": people[0], "subtrees": people[1]},
                                         "house": {"roots": house[0], "subtrees": house[1]}}
        cursors = {tree: self.pull(self.mine, f"tree/{tree}")[2] for tree in (self.unlisted, self.subtree)}
        self.assertEqual(self.pull(self.reader, f"tree/{self.unlisted}")[0], "rows")
        metas = self.metas()
        self.assertEqual({tree for tree, meta in metas.items() if "unlisted" in (meta[0], meta[2])},
                         self.moved | {self.reach_only, self.deleted, self.house, self.under_house})

        snapshot = self.snapshot()
        counts, lines = self.run_tool()
        self.assertEqual(counts, {"write": False,
                                  "unlisted": {"before": counted((4, 2), (1, 1)), "after": counted((4, 2), (1, 1))},
                                  "roots": {"toMove": 3, "moved": 0, "unchanged": 0, "busy": 0, "reachOnly": 1,
                                            "refused": {"house-roadmap": 1}}})
        self.assertEqual(lines, [("roadmap.unlisted.to_private", "tool", "dry-run", 1)])
        self.assertEqual(self.snapshot(), snapshot)

        # Another writer holds their roadmap's scope row past the engine's lock timeout while the tool writes: that root
        # is busy and written nothing, and the run goes on to the others.
        holder = subprocess.Popen(["psql", self.url, "-XAtq", "-v", "ON_ERROR_STOP=1"], stdin=subprocess.PIPE,
                                  stdout=subprocess.DEVNULL, text=True)
        self.addCleanup(holder.kill)
        holder.stdin.write(f"BEGIN;\nSELECT 1 FROM sync_scopes WHERE key = 'tree:{self.theirs}' FOR UPDATE;\n")
        holder.stdin.flush()
        until = time.time() + 30
        while psql(self.url, "-c", f"SELECT key FROM sync_scopes WHERE key = 'tree:{self.theirs}' FOR UPDATE SKIP LOCKED"):
            self.assertLess(time.time(), until, "the holder did not take the scope's row within 30 s")
            time.sleep(0.05)
        counts, lines = self.run_tool("--write")
        holder.communicate("COMMIT;\n", timeout=30)
        self.assertEqual(holder.returncode, 0)
        self.assertEqual(counts, {"write": True,
                                  "unlisted": {"before": counted((4, 2), (1, 1)), "after": counted((2, 0), (1, 1))},
                                  "roots": {"toMove": 3, "moved": 2, "unchanged": 0, "busy": 1, "reachOnly": 1,
                                            "refused": {"house-roadmap": 1}}})
        self.assertEqual(sorted(lines), [("roadmap.server_call", "tool", "busy", None),
                                         ("roadmap.unlisted.move", "tool", "busy", None),
                                         ("roadmap.unlisted.move", "tool", "house-roadmap", None),
                                         ("roadmap.unlisted.move", "tool", "moved", None),
                                         ("roadmap.unlisted.move", "tool", "moved", None),
                                         ("roadmap.unlisted.to_private", "tool", "busy", 1),
                                         ("sync.admit", "server-origin", "unavailable", None)])
        after = self.metas()
        self.assertEqual({tree for tree in metas if after[tree] != metas[tree]}, self.moved - {self.theirs})

        # A run again moves the busy root.
        counts, lines = self.run_tool("--write")
        self.assertEqual(counts, {"write": True,
                                  "unlisted": {"before": counted((2, 0), (1, 1)), "after": counted((1, 0), (1, 1))},
                                  "roots": {"toMove": 1, "moved": 1, "unchanged": 0, "busy": 0, "reachOnly": 1,
                                            "refused": {"house-roadmap": 1}}})
        self.assertEqual(sorted(lines), [("roadmap.unlisted.move", "tool", "house-roadmap", None),
                                         ("roadmap.unlisted.move", "tool", "moved", None),
                                         ("roadmap.unlisted.to_private", "tool", "moved", 1)])
        after = self.metas()
        self.assertEqual({tree for tree in metas if after[tree] != metas[tree]}, self.moved)
        roots = {self.unlisted, self.bare, self.theirs}
        for tree in self.moved:
            visibility, visibility_stamp, reach, reach_stamp, _ = after[tree]
            with self.subTest(tree="root" if tree in roots else "subtree"):
                self.assertEqual((visibility, reach), ("private", "private") if tree in roots else ("", "private"))
                self.assertRegex(reach_stamp, r"^[0-9]+:[0-9]+:srv$")
                if tree in roots:
                    self.assertRegex(visibility_stamp, r"^[0-9]+:[0-9]+:srv$")

        # The owner's replica pulls each change from where it stood, and the reader no longer reads the roadmap.
        kind, rows, _ = self.pull(self.mine, f"tree/{self.unlisted}", cursors[self.unlisted])
        self.assertEqual((kind, [(row["t"], row["f"]["visibility"][0], row["f"]["reach"][0]) for row in rows]),
                         ("rows", [("meta", "private", "private")]))
        self.assertEqual(rows[0]["f"]["visibility"][1], after[self.unlisted][1])
        kind, rows, _ = self.pull(self.mine, f"tree/{self.subtree}", cursors[self.subtree])
        self.assertEqual((kind, [(row["t"], row["f"]["reach"][0]) for row in rows]), ("rows", [("meta", "private")]))
        self.assertEqual(self.pull(self.reader, f"tree/{self.unlisted}")[0], "not-found")
        self.assertEqual(self.pull(self.reader, f"tree/{self.public}")[0], "rows")

        # A run after that writes nothing, and the root whose reach alone reads unlisted is still counted, never written.
        snapshot = self.snapshot()
        counts, lines = self.run_tool("--write")
        self.assertEqual(counts, {"write": True,
                                  "unlisted": {"before": counted((1, 0), (1, 1)), "after": counted((1, 0), (1, 1))},
                                  "roots": {"toMove": 0, "moved": 0, "unchanged": 0, "busy": 0, "reachOnly": 1,
                                            "refused": {"house-roadmap": 1}}})
        self.assertEqual(sorted(lines), [("roadmap.unlisted.move", "tool", "house-roadmap", None),
                                         ("roadmap.unlisted.to_private", "tool", "unchanged", 1)])
        self.assertEqual(self.snapshot(), snapshot)


if __name__ == "__main__":
    unittest.main(verbosity=2)
