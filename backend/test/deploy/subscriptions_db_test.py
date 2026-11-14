#!/usr/bin/env python3
# The subscriptions-db one-shot (deploy/subscriptions-db) against the production compose's Postgres 16 holding
# rows of the backend's: whatever rules or live pg_hba.conf it meets, the backend's role keeps its database.
# Each test runs on a volume of its own. Needs Docker with compose.
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import unittest


DEPLOY = Path(__file__).resolve().parents[2] / "deploy"
HBA = "/var/lib/postgresql/data/pg_hba.conf"
BACKEND_ROWS = "select count(*) from backend_rows"


class SubscriptionsDbTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="subscriptions-db-test-")
        self.addCleanup(directory.cleanup)
        self.project = Path(directory.name)
        shutil.copy(DEPLOY / "docker-compose.yml", self.project)
        shutil.copytree(DEPLOY / "subscriptions-db", self.project / "subscriptions-db")
        self.name = "subscriptions-db-test-" + secrets.token_hex(4)
        self.superuser_password = secrets.token_hex(16)
        self.password = secrets.token_hex(32)
        self.write_env(password="")
        self.addCleanup(self.compose, "down", "-v", "--remove-orphans", check=False)
        self.compose("up", "-d", "--wait", "db")
        self.compose("exec", "-T", "db", "psql", "-XAq", "-v", "ON_ERROR_STOP=1", "-U", "windmill", "windmill",
                     "-c", "create table backend_rows (id int primary key)",
                     "-c", "insert into backend_rows select generate_series(1, 3)")

    def write_env(self, password):
        (self.project / ".env").write_text(
            f"POSTGRES_PASSWORD={self.superuser_password}\nSUBSCRIPTIONS_DB_PASSWORD={password}\n"
            "DOMAIN_APP=app.localhost\nDOMAIN_API=api.localhost\nACME_EMAIL=ops@example.invalid\n")

    def compose(self, *arguments, check=True, environment=None):
        return subprocess.run(["docker", "compose", "-p", self.name, *arguments], cwd=self.project,
                              env={**os.environ, **(environment or {})}, capture_output=True, text=True,
                              timeout=180, check=check)

    def provision(self):
        return self.compose("run", "--rm", "-T", "subscriptions-db", check=False)

    def add_rule(self, rule):
        rules = self.project / "subscriptions-db/pg_hba.conf"
        rules.write_text(rules.read_text() + rule + "\n")

    def hba(self):
        return self.compose("exec", "-T", "db", "cat", HBA).stdout

    # What `role` gets on `database` with `password`, from another container as the backend connects and over
    # the db container's socket: its rows' count, or how it was turned away.
    def reach(self, role, database, password, query="select 1"):
        def outcome(result):
            if result.returncode == 0:
                return result.stdout.strip()
            if "pg_hba.conf rejects connection" in result.stderr:
                return "rejected"
            if "password authentication failed" in result.stderr or "no password supplied" in result.stderr:
                return "password refused"
            return "failed: " + result.stderr.strip().splitlines()[-1]
        network = subprocess.run(
            ["docker", "run", "--rm", "--network", self.name + "_default", "-e", "PGPASSWORD", "postgres:16",
             "psql", "-XAtw", f"host=db user={role} dbname={database}", "-c", query],
            env={**os.environ, "PGPASSWORD": password}, capture_output=True, text=True, timeout=60)
        socket = self.compose("exec", "-T", "-e", "PGPASSWORD", "db", "psql", "-XAtw", "-U", role, database, "-c",
                              query, check=False, environment={"PGPASSWORD": password})
        return outcome(network), outcome(socket)

    def backend(self):
        return self.reach("windmill", "windmill", self.superuser_password, BACKEND_ROWS)

    def test_without_its_password_it_provisions_nothing(self):
        before = self.hba()

        result = self.provision()

        self.assertEqual((result.returncode, result.stdout), (0,
            "SKIP subscriptions database: SUBSCRIPTIONS_DB_PASSWORD is not set, so nothing was provisioned\n"))
        self.assertEqual(self.hba(), before)
        self.assertEqual(self.backend(), ("3", "3"))
        self.assertEqual(self.reach("windmill", "windmill", self.superuser_password,
                                    "select count(*) from pg_roles where rolname = 'windmill_subscriptions'"),
                         ("0", "0"))

    def test_twice_with_its_password_it_closes_the_ledger_to_every_role_but_its_own(self):
        self.write_env(self.password)

        first = self.provision()
        installed = self.hba()
        second = self.provision()

        self.assertEqual([(first.returncode, first.stdout), (second.returncode, second.stdout)], [
            (0, "PASS subscriptions database: windmill_subscriptions provisioned, refused to the backend role"
                " (rules installed)\n"),
            (0, "PASS subscriptions database: windmill_subscriptions provisioned, refused to the backend role"
                " (rules unchanged)\n")])
        self.assertEqual(self.hba(), installed)
        self.assertEqual(installed.count("# BEGIN windmill_subscriptions"), 1)
        self.assertEqual(self.backend(), ("3", "3"))
        self.assertEqual([
            self.reach("windmill", "windmill_subscriptions", self.superuser_password),
            self.reach("windmill_subscriptions", "windmill_subscriptions", self.password, "select current_user"),
            self.reach("windmill_subscriptions", "windmill_subscriptions", "not-its-password"),
            self.reach("windmill_subscriptions", "windmill", self.password),
            self.reach("windmill_subscriptions", "postgres", self.password)], [
            ("rejected", "rejected"),
            ("windmill_subscriptions", "windmill_subscriptions"),
            ("password refused", "password refused"),
            ("rejected", "rejected"),
            ("rejected", "rejected")])

    def test_rules_without_a_final_newline_still_close_their_block(self):
        rules = self.project / "subscriptions-db/pg_hba.conf"
        rules.write_text(rules.read_text().rstrip("\n"))
        self.write_env(self.password)

        first, second = self.provision(), self.provision()

        self.assertEqual([(first.returncode, first.stdout[-17:]), (second.returncode, second.stdout[-17:])],
                         [(0, "rules installed)\n"), (0, "rules unchanged)\n")])
        self.assertIn("\n# END windmill_subscriptions\n", self.hba())
        self.assertEqual(self.backend(), ("3", "3"))

    def test_a_block_left_open_in_the_live_file_stops_the_run_and_changes_nothing(self):
        self.compose("exec", "-T", "-u", "postgres", "db", "sed", "-i",
                     "1i # BEGIN windmill_subscriptions: opened by hand", HBA)
        before = self.hba()
        self.write_env(self.password)

        result = self.provision()

        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL subscriptions database: pg_hba.conf holds a windmill_subscriptions block with no end,"
                      " so it is left as it was", result.stderr.splitlines())
        self.assertEqual(self.hba(), before)
        self.assertEqual(self.backend(), ("3", "3"))

    def test_rules_that_would_turn_the_backend_away_are_never_put_in_force(self):
        self.add_rule("host    all    windmill    all    reject")
        before = self.hba()
        self.write_env(self.password)

        result = self.provision()

        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL subscriptions database: the rewritten pg_hba.conf would not admit the backend's role,"
                      " so it is left as it was", result.stderr.splitlines())
        self.assertEqual(self.hba(), before)
        self.assertEqual(self.backend(), ("3", "3"))

    def test_rules_that_turn_the_backend_away_once_reloaded_are_taken_back(self):
        self.add_rule("host    windmill    windmill    0.0.0.0/0    reject")
        before = self.hba()
        self.write_env(self.password)

        result = self.provision()

        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL subscriptions database: the reloaded rules did not hold for the backend's role, so the"
                      " previous pg_hba.conf is back in force", result.stderr.splitlines())
        self.assertEqual(self.hba(), before)
        self.assertEqual(self.backend(), ("3", "3"))


if __name__ == "__main__":
    unittest.main()
