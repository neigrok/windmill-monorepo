import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import unittest


TOOL = sys.argv.pop(1)
SCHEMA = sys.argv.pop(1)
FIXTURE = sys.argv.pop(1)
WRITE = re.compile(rb'write (\{[^\n]*\}) - ')
STAGES = ["unfold", "read-models-before", "before", "adopt", "demo", "after", "read-models", "digests"]

OWNER = "aaaaaaaa-0000-4000-8000-00000000000a"
READER = "bbbbbbbb-0000-4000-8000-00000000000b"
SCRIBBLER = "cccccccc-0000-4000-8000-00000000000c"
HOUSE = "00000000-0000-4000-8000-00000000d3e0"
DEMO = "t_9e407a96b5330ebe"
EXPECTED_OWNERLESS = ["t_c000000000000001", "t_d000000000000001"]

# What the fixture holds that no line anyone may read can name: its roadmaps, steps, accounts and texts.
NAMED = [OWNER, READER, SCRIBBLER, "dddddddd-0000-4000-8000-00000000000d", DEMO, "Learn the cello", "Practise daily",
         "Hold the bow", "Thumb bent", "Bake bread", "Scribbles", "owner@example.com", "example.com/bow", "r_owner",
         *[f"t_{prefix}{n:015x}" for prefix in "abcde" for n in range(1, 8)]]

BEFORE = {
    "documents": {"before": 11},
    "kept": {"activityLines": 2, "shareCards": 1, "shareVideos": 1},
    "kinds": {"alive": 7, "dead": 1, "rankGivenAKey": 8},
    "links": {"alive": 27, "dead": 1},
    "marks": {"adopted": 7},
    "notAdopted": {"deletedRoadmaps": 2, "linksFromAStepToItself": 1, "linksToAnIdNoStepHolds": 3, "linksWithNeitherStamp": 1,
                   "marksOfNoAccount": 1, "stepsWithNeitherStamp": 1},
    "ord": {"emptyGivenAKey": 22, "malformedGivenAKey": 1},
    "overlays": {"owners": 3, "readers": 2},
    "ownerless": {"expected": 3},
    "pointers": {"adopted": 2, "clearedReadAsNone": 1},
    "roadmaps": {"adopted": 11, "roots": 10, "subtrees": 3, "total": 13, "unreadableToday": 2, "wholeDocument": 1},
    "seq": {"continuedAboveAHead": 3},
    "stamps": {"future": 1, "kept": 170, "malformed": 7, "unset": 249, "unsetHoldingAValue": 9},
    "steps": {"alive": 41, "dead": 3, "owningASubtree": 2},
    "subtrees": {"hidden": 1, "standing": 1},
    "values": {"markStatusReadAsNone": 1, "statusReadAsNone": 1, "unknownColorReadAsTerracotta": 1},
}
ADOPTED = {key: value for key, value in BEFORE.items() if key not in ("documents", "kept", "ownerless", "roadmaps", "subtrees")}
ADOPTED["notAdopted"] = {key: value for key, value in BEFORE["notAdopted"].items() if key != "deletedRoadmaps"}
READ_MODELS = {
    "mcp": {"seqContinuedAboveTheOld": 5},
    "same": {"activity": {"tail": 6, "tailToAStranger": 3}, "mcp": {"getProgress": 6, "getTree": 6, "listTrees": 2},
             "progress": {"toAStranger": 9, "toTheOwner": 6}, "reminders": {"readiness": 2},
             "sharePage": {"toAStranger": 9, "toTheOwner": 6}, "gallery": 1},
    "unreadableToday": {"activity": {"tail": 2}, "mcp": {"getProgress": 2, "getTree": 2, "listTrees": 1},
                        "progress": {"toAStranger": 2, "toTheOwner": 2}, "reminders": {"readiness": 1},
                        "sharePage": {"toAStranger": 2, "toTheOwner": 2}},
}


def psql(url, *arguments, sql=None):
    return subprocess.run(["psql", url, "-XAtq", "-v", "ON_ERROR_STOP=1", *arguments], input=sql, text=True,
                          capture_output=True, check=True, timeout=120).stdout


def query(url, sql):
    return psql(url, "-c", sql).strip()


# Each case runs the tool on a database of its own: db/schema.sql, which seeds the public demo, the fixture, and `sql`.
def own_database(test, name, sql=""):
    maintenance = os.environ.get("DATABASE_URL")
    if not maintenance:
        raise unittest.SkipTest("WM_PG_TEST requires DATABASE_URL")
    database = f"wm_roadmap_adopt_{name}_{os.getpid()}"
    psql(maintenance, "-c", f'DROP DATABASE IF EXISTS "{database}"')
    psql(maintenance, "-c", f'CREATE DATABASE "{database}" TEMPLATE template0 ENCODING \'UTF8\'')
    test.addCleanup(psql, maintenance, "-c", f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
    url = re.sub(r"^(postgres(?:ql)?://[^/?]*)/[^?]*", rf"\1/{database}", maintenance)
    if url == maintenance:
        raise AssertionError("DATABASE_URL names no database to replace")
    psql(url, "-f", SCHEMA)
    psql(url, "-f", FIXTURE)
    if sql:
        psql(url, sql=sql)
    return url


class ToolTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="roadmap-adopt-")
        self.addCleanup(directory.cleanup)
        self.private = Path(directory.name) / "private"
        expected = Path(directory.name) / "expected-ownerless"
        expected.write_text("\n".join(EXPECTED_OWNERLESS) + "\n")
        self.env = {**os.environ, "SENTRY_DSN": "", "PGCONNECT_TIMEOUT": "1",
                    "WINDMILL_LOG_EMERGENCY_FILE": str(Path(directory.name) / "emergency.log"),
                    "ROADMAP_ADOPTION_PRIVATE_DIR": str(self.private), "ROADMAP_ADOPTION_EXPECTED_OWNERLESS": str(expected)}

    def run_tool(self, url, stage, env=None):
        result = subprocess.run([TOOL, stage], capture_output=True, env={**(env or self.env), "DATABASE_URL": url}, timeout=120)
        reports = [json.loads(line) for line in result.stdout.decode().splitlines()]
        return result, reports

    def stage_lines(self, result):
        return [(record["operation"], record["outcome"]) for record in map(json.loads, WRITE.findall(result.stderr))
                if record["operation"].startswith("roadmap.adoption.")]

    def assert_names_nothing(self, result):
        for name in NAMED:
            with self.subTest(name=name):
                self.assertNotIn(name.encode(), result.stdout)
                self.assertNotIn(name.encode(), result.stderr)

    def engine(self, url):
        return psql(url, "-c", "select md5(string_agg(s::text, ',' order by key)) from sync_scopes s",
                    *[arg for table in ("roadmap_trees", "roadmap_metas", "roadmap_nodes", "roadmap_edges", "roadmap_kinds",
                                        "roadmap_progress", "roadmap_pointers")
                      for arg in ("-c", f"select md5(string_agg(r::text, ',' order by scope_key, id)) from {table} r")])


class ConfigurationTest(ToolTest):
    def test_a_stage_it_does_not_know_or_no_database_is_refused_before_anything_runs(self):
        for arguments, env in ((["nothing"], self.env), ([], self.env), (["all"], {k: v for k, v in self.env.items() if k != "DATABASE_URL"})):
            with self.subTest(arguments=arguments):
                result = subprocess.run([TOOL, *arguments], capture_output=True, env=env, timeout=60)
                self.assertEqual(result.returncode, 2, result.stderr.decode())
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"usage: windmill_roadmap_adopt", result.stderr)


@unittest.skipUnless(os.environ.get("WM_PG_TEST"), "SKIP: set WM_PG_TEST and DATABASE_URL for Postgres cases")
class AdoptionTest(ToolTest):
    def test_every_stage_passes_on_the_fixture_counting_each_rule_and_a_second_run_changes_nothing(self):
        url = own_database(self, "stages")
        result, reports = self.run_tool(url, "all")
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual([(report["stage"], report["verdict"]) for report in reports],
                         list(zip(STAGES, ["unfolded", "asked", "ready", "adopted", "present", "same", "same", "summed"])))
        counts = {report["stage"]: report["counts"] for report in reports}
        self.assertEqual(counts["unfold"], {"oldServer": {"couldNotOpen": 2, "opened": 9},
                                            "wholeDocuments": {"leftAsTheyWere": 1, "unfoldedIntoRows": 1}})
        self.assertEqual(counts["read-models-before"], {"answers": 72})
        self.assertEqual(counts["before"], BEFORE)
        self.assertEqual(counts["adopt"], {**ADOPTED, "adopted": {"owners": 4, "roadmaps": 13}})
        self.assertEqual(counts["demo"], {})
        self.assertEqual(counts["after"], {"roadmaps": {"same": 11}, "spentIds": {"held": 2}})
        self.assertEqual(counts["read-models"], READ_MODELS)
        self.assertEqual(counts["digests"], {"scopes": {"digestHolds": 20, "summed": 20}})
        self.assertEqual(self.stage_lines(result), [(f"roadmap.adoption.{stage}", report["verdict"]) for stage, report in zip(STAGES, reports)])
        self.assert_names_nothing(result)
        self.assertEqual(sorted(path.name for path in self.private.iterdir()),
                         ["after.jsonl", "before.jsonl", "differences.jsonl", "digests.jsonl", "read-models-before.jsonl",
                          "read-models.jsonl", "stops.jsonl"])
        for path in self.private.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len((self.private / "before.jsonl").read_text().splitlines()), 11)
        self.assertEqual((self.private / "before.jsonl").read_text(), (self.private / "after.jsonl").read_text())

        adopted = self.engine(url)
        again, reports = self.run_tool(url, "all")
        self.assertEqual(again.returncode, 0, again.stderr.decode())
        self.assertEqual([(report["stage"], report["verdict"]) for report in reports],
                         list(zip(STAGES, ["unfolded", "asked", "ready", "unchanged", "present", "same", "same", "summed"])))
        self.assertEqual(reports[0]["counts"], {"oldServer": {"couldNotOpen": 2, "opened": 9}, "wholeDocuments": {"leftAsTheyWere": 1}})
        self.assertEqual(reports[3]["counts"], {"alreadyAdopted": {"roadmaps": 13}})
        self.assertEqual(self.engine(url), adopted)
        self.assert_names_nothing(again)

    def test_the_engines_tables_hold_each_rule_as_the_fixture_states_it(self):
        url = own_database(self, "rules")
        result, _ = self.run_tool(url, "all")
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        cello = "t_a000000000000001"
        self.assertEqual(query(url, f"select owner, governed_by, seq, open, counters from sync_scopes where key = 'tree:{cello}'"),
                         f"{OWNER}|acct:{OWNER}/roadmap#tree#{cello}|30|t|{{\"edge\": 2, \"kind\": 3, \"node\": 11}}")
        self.assertEqual(query(url, f"select min(seq), max(seq) from (select seq from roadmap_metas where scope_key = 'tree:{cello}' "
                                    f"union all select seq from roadmap_nodes where scope_key = 'tree:{cello}') rows"), "10|23")
        self.assertEqual(query(url, f"select title, title_stamp, guide, guide_stamp, guide_inherited, guide_inherited_stamp, visibility, "
                                    f"visibility_stamp, reach, root, depth, forked_from, rc, ru from roadmap_metas where scope_key = 'tree:{cello}'"),
                         "Learn the cello|0:0:srv|Practise daily|1740000000000:0:r_owner|t|0:0:srv|public|0:0:srv|public|||"
                         "t_b000000000000001|1735689600000|" + query(url, f"select (extract(epoch from updated_at) * 1000)::bigint from trees where id = '{cello}'"))
        nodes = {line.split("~")[0]: line.split("~")[1:] for line in query(url, (
            "select concat_ws('~', id, life, born, life_stamp, coalesce(label, '-'), coalesce(label_stamp, '-'), coalesce(color, '-'), "
            f"coalesce(status, '-'), ord, coalesce(branch, '-'), rc, ru) from roadmap_nodes where scope_key = 'tree:{cello}'")).splitlines()}
        self.assertNotIn("neither", nodes)
        self.assertEqual(nodes["dead"][0], "dead")
        self.assertEqual(nodes["revived"][:3], ["alive", "1740000000002:7:r_owner", "1740000000002:7:r_owner"])
        self.assertEqual(nodes["removed-only"][:3], ["dead", "0:0:srv", "1740000000001:8:r_owner"])
        self.assertEqual(nodes["future"][4], "0:0:srv")
        self.assertEqual(nodes["unset"][3:5], ["Tune", "0:0:srv"])
        self.assertEqual(nodes["active"][5:7], ["terracotta", "none"])
        self.assertEqual(nodes["owning"][8], "t_a000000000000002")
        self.assertEqual(nodes["late"][-1], "1750000000000")
        self.assertEqual(query(url, "select rc, ru from roadmap_nodes where scope_key = 'tree:t_b000000000000001' and id = 'late'"),
                         "1740000000000|1748736000000")
        self.assertEqual(nodes["kept"][-2:], ["1740000000000", "1740000000000"])
        keys = {id: columns[7] for id, columns in nodes.items()}
        self.assertLess(keys["empty-ord"], keys["owning"])
        self.assertLess(keys["dead"], keys["bad-ord"])
        self.assertLess(keys["bad-ord"], keys["revived"])
        self.assertEqual(query(url, f"select id, life from roadmap_edges where scope_key = 'tree:{cello}' order by id"),
                         '["kept","future"]|dead\n["kept","unset"]|alive\n["owning","kept"]|alive')
        self.assertEqual(query(url, f"select id, ord, ord_stamp from roadmap_kinds where scope_key = 'tree:{cello}' order by ord"),
                         "learn|a0|1740000000000:0:r_owner\nbuild|a1|1740000000000:0:r_owner\ngone|a2|1740000000000:0:r_owner\nlater|a3|0:0:srv")
        self.assertEqual(query(url, f"select s.owner, p.id, p.mark::text, p.mark_stamp, p.rc from roadmap_progress p join sync_scopes s on s.key = p.scope_key "
                                    f"where s.governed_by = 'tree:{cello}' order by 1, 2"),
                         f'{OWNER}|future|{{"status": "none", "outOfOrder": false}}|0:0:srv|1741000003000\n'
                         f'{OWNER}|kept|{{"status": "complete", "outOfOrder": true}}|1740000000000:30:r_owner|1741000000000\n'
                         f'{OWNER}|nowhere|{{"status": "complete", "outOfOrder": false}}|1740000000000:34:r_owner|1741000006000\n'
                         f'{OWNER}|unset|{{"status": "none", "outOfOrder": false}}|1740000000000:31:r_owner|1741000001000\n'
                         f'{READER}|kept|{{"status": "complete", "outOfOrder": false}}|1740000000000:32:r_reader|1741000004000')
        self.assertEqual(query(url, f"select id, life, opens, opens_stamp from roadmap_pointers where scope_key = 'acct:{OWNER}/overlay/{cello}'"),
                         "opener|alive|t_a000000000000003|1740000000000:14:r_owner")
        self.assertEqual(query(url, "select id, root, parent::text, depth, reach from roadmap_metas where scope_key in "
                                    "('tree:t_a000000000000002', 'tree:t_a000000000000004') order by scope_key"),
                         'meta|t_a000000000000001|{"step": "owning", "tree": "t_a000000000000001"}|1|public\n'
                         'meta|t_a000000000000001|{"step": "deep-owning", "tree": "t_a000000000000002"}|2|private')
        self.assertEqual(query(url, "select t.id, t.life, t.parent is null, s.state, s.dead_at, s.seq from roadmap_trees t "
                                    "join sync_scopes s on s.key = 'tree:' || t.id where t.id in ('t_a000000000000005', 't_a000000000000006') order by 1"),
                         "t_a000000000000005|dead|t|dead|1747000000000|0\nt_a000000000000006|dead|t|dead|1747000000000|0")
        self.assertEqual(query(url, f"select id from roadmap_trees where scope_key = 'acct:{HOUSE}/roadmap' order by id"),
                         f"t_9e407a96b5330ebe\nt_c000000000000001\nt_d000000000000001")
        self.assertEqual(query(url, f"select email from users where id = '{HOUSE}'"), "house@windmill.invalid")
        self.assertEqual(query(url, f"select count(*), max(seq) from tree_ops where tree_id = '{cello}'"), "2|9")

    def test_a_run_killed_between_stages_and_in_the_middle_of_adopt_finishes_when_run_again(self):
        url = own_database(self, "killed")
        for stage in STAGES[:3]:
            result, _ = self.run_tool(url, stage)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
        # The scribbler's first roadmap held mid-insert: the move commits the house's, the owner's and the reader's
        # roadmaps, one owner a transaction, then sleeps inside the scribbler's, the last owner's.
        query(url, "create function held_insert() returns trigger language plpgsql as $$ begin "
                   "if new.id = 't_e000000000000001' then perform pg_sleep(60); end if; return new; end $$; "
                   "create trigger held_insert before insert on roadmap_trees for each row execute function held_insert()")
        tool = subprocess.Popen([TOOL, "adopt"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**self.env, "DATABASE_URL": url})
        self.addCleanup(tool.wait)
        self.addCleanup(tool.kill)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if query(url, "select count(*) from pg_stat_activity where wait_event = 'PgSleep' and datname = current_database()") == "1":
                break
            time.sleep(0.1)
        self.assertEqual(query(url, "select count(*) from roadmap_trees"), "11")
        tool.send_signal(signal.SIGKILL)
        tool.wait(timeout=30)
        # The killed run's session, which Postgres ends once it notices its client gone, and the trigger.
        query(url, "select count(pg_terminate_backend(pid)) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()")
        query(url, "drop trigger held_insert on roadmap_trees; drop function held_insert()")
        self.assertEqual(query(url, f"select count(*) from sync_scopes where owner = '{SCRIBBLER}'"), "0")

        result, reports = self.run_tool(url, "all")
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(reports[3]["counts"]["adopted"], {"owners": 1, "roadmaps": 2})
        self.assertEqual(reports[3]["counts"]["alreadyAdopted"], {"roadmaps": 11})
        self.assertEqual([(report["stage"], report["verdict"]) for report in reports[5:]],
                         [("after", "same"), ("read-models", "same"), ("digests", "summed")])

    def test_no_stage_runs_beside_another_client_and_a_row_changed_after_the_plan_stops_the_move(self):
        url = own_database(self, "alone")
        sleeper = subprocess.Popen(["psql", url, "-XAtq", "-c", "select pg_sleep(60)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(sleeper.wait)
        self.addCleanup(sleeper.kill)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and query(url, "select count(*) from pg_stat_activity where wait_event = 'PgSleep'") != "1":
            time.sleep(0.1)
        for stage in STAGES:
            with self.subTest(stage=stage):
                result, reports = self.run_tool(url, stage)
                self.assertEqual(result.returncode, 3, result.stderr.decode())
                self.assertEqual((reports[0]["verdict"], reports[0]["counts"]), ("othersConnected", {"sessions": {"otherClients": 1}}))
                self.assertEqual(self.stage_lines(result), [(f"roadmap.adoption.{stage}", "othersConnected")])
        sleeper.kill()
        sleeper.wait(timeout=30)
        query(url, "select count(pg_terminate_backend(pid)) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()")
        self.assertEqual(query(url, "select count(*) from sync_scopes"), "0")

        # A writer that reaches roadmap's tables once the stage began: the house's transaction is held open while it
        # commits a step of the scribbler's, which the scribbler's transaction finds on reading their rows again.
        query(url, "create function held_house() returns trigger language plpgsql as $$ begin "
                   f"if new.id = '{DEMO}' then perform pg_sleep(2); end if; return new; end $$; "
                   "create trigger held_house before insert on roadmap_trees for each row execute function held_house()")
        tool = subprocess.Popen([TOOL, "adopt"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={**self.env, "DATABASE_URL": url})
        self.addCleanup(tool.kill)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and query(url, "select count(*) from pg_stat_activity where wait_event = 'PgSleep'") != "1":
            time.sleep(0.02)
        query(url, "insert into tree_nodes (tree_id, node_id, created_hlc, label, label_hlc, present) values "
                   "('t_e000000000000001', 'late', '1740000000000:99:r_scribbler', 'Late', '1740000000000:99:r_scribbler', true)")
        stdout, _ = tool.communicate(timeout=60)
        self.assertEqual(tool.returncode, 3)
        report = json.loads(stdout)
        self.assertEqual((report["verdict"], report["counts"]["stop"], report["counts"]["adopted"]),
                         ("stops", {"oldRowsChangedSinceThePlan": 1}, {"owners": 3, "roadmaps": 11}))
        self.assertEqual((self.private / "adopt-failure.jsonl").read_text(),
                         f'{{"owner":"{SCRIBBLER}","reason":"oldRowsChangedSinceThePlan","roadmap":""}}\n')
        self.assertEqual(query(url, "select count(*) from roadmap_trees where id like 't_e%'"), "0")

    def test_a_row_the_move_cannot_read_as_the_spec_says_stops_it_before_it_writes_anything(self):
        url = own_database(self, "corrupted", "insert into tree_nodes (tree_id, node_id, created_hlc, status, status_hlc, present) "
                                              "values ('t_a000000000000001', 'odd', '1740000000000:90:r_owner', 'banana', "
                                              "'1740000000000:90:r_owner', true);")
        for stage in ("before", "adopt"):
            with self.subTest(stage=stage):
                result, reports = self.run_tool(url, stage)
                self.assertEqual(result.returncode, 3, result.stderr.decode())
                self.assertEqual(reports[0]["verdict"], "stops")
                self.assertEqual(reports[0]["counts"]["stop"], {"unknownStepStatus": 1})
                self.assertEqual(self.stage_lines(result), [(f"roadmap.adoption.{stage}", "stops")])
                self.assert_names_nothing(result)
        self.assertEqual(query(url, "select (select count(*) from sync_scopes), (select count(*) from roadmap_trees), "
                                    f"(select count(*) from users where id = '{HOUSE}')"), "0|0|0")
        self.assertEqual((self.private / "stops.jsonl").read_text(),
                         '{"reason":"stop.unknownStepStatus","roadmap":"t_a000000000000001"}\n')

    def test_a_roadmap_with_no_owner_it_was_not_told_to_expect_stops_the_move(self):
        url = own_database(self, "ownerless")
        env = {key: value for key, value in self.env.items() if key != "ROADMAP_ADOPTION_EXPECTED_OWNERLESS"}
        result, reports = self.run_tool(url, "adopt", env)
        self.assertEqual(result.returncode, 3, result.stderr.decode())
        self.assertEqual(reports[0]["counts"], {"stop": {"unexpectedOwnerlessRoadmap": 2}})
        self.assertEqual(query(url, "select count(*) from roadmap_trees"), "0")

    def test_the_demo_is_seeded_when_the_engine_lacks_it_and_never_written_again(self):
        url = own_database(self, "demo")
        result, reports = self.run_tool(url, "demo")
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual((reports[0]["verdict"], reports[0]["counts"]), ("seeded", {"adopted": {"roadmaps": 1}}))
        self.assertEqual(query(url, f"select s.owner, m.title, m.reach from roadmap_trees t join sync_scopes s on s.key = t.scope_key "
                                    f"join roadmap_metas m on m.scope_key = 'tree:' || t.id where t.id = '{DEMO}'"),
                         f"{HOUSE}|Learn to sail|public")
        seeded = self.engine(url)
        psql(url, "-c", f"update trees set title = 'Renamed' where id = '{DEMO}'", "-f", SCHEMA)
        result, reports = self.run_tool(url, "demo")
        self.assertEqual((result.returncode, reports[0]["verdict"]), (0, "present"))
        self.assertEqual(self.engine(url), seeded)


if __name__ == "__main__":
    unittest.main(verbosity=2)
