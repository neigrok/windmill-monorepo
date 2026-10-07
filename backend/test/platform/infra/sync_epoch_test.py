import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest


TOOL = sys.argv.pop(1)
BEFORE = "a" * 32
AFTER = "b" * 32
OTHER = "c" * 32
WRITE = re.compile(rb'write (\{[^\n]*\}) - ')


class ToolTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="ep-sync-epoch-")
        self.addCleanup(directory.cleanup)
        self.backup = Path(directory.name) / "emergency.log"
        self.env = {**os.environ, "SENTRY_DSN": "", "PGCONNECT_TIMEOUT": "1",
                    "WINDMILL_LOG_EMERGENCY_FILE": str(self.backup)}

    def invoke(self, *arguments, env=None):
        return subprocess.run([TOOL, *arguments], capture_output=True, env=env or self.env, timeout=10)

    def completion(self, result, code, outcome):
        self.assertEqual(result.returncode, code, result.stderr.decode())
        self.assertEqual(result.stdout, b"")
        records = [json.loads(match) for match in WRITE.findall(result.stderr)]
        self.assertEqual(len(records), 1, result.stderr.decode())
        record = records[0]
        self.assertEqual(set(record), {"operation", "product", "door", "outcome", "duration_ms", "request_id"})
        self.assertEqual((record["operation"], record["product"], record["door"], record["outcome"]),
                         ("sync.epoch.rotate", "platform", "tool", outcome))
        self.assertGreaterEqual(record["duration_ms"], 0)
        self.assertRegex(record["request_id"], r"^[0-9a-f]{32}$")
        for epoch in (BEFORE, AFTER, OTHER):
            self.assertNotIn(epoch.encode(), result.stderr)

    def finish_process(self, process):
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)


class ArgumentsTest(ToolTest):
    def test_invalid_arguments_are_logged_without_opening_postgres(self):
        env = {**self.env, "DATABASE_URL": "not a connection string"}
        cases = [(), (BEFORE,), (BEFORE, AFTER, OTHER), ("", AFTER), ("x" * 129, AFTER),
                 (BEFORE, "B" * 32), (BEFORE, "b" * 31), (BEFORE, "z" * 32), (BEFORE, BEFORE)]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                self.completion(self.invoke(*arguments, env=env), 2, "invalid-arguments")

    def test_missing_configuration_is_logged(self):
        for value in (None, ""):
            env = dict(self.env)
            env.pop("DATABASE_URL", None)
            if value is not None:
                env["DATABASE_URL"] = value
            with self.subTest(value=value):
                self.completion(self.invoke(BEFORE, AFTER, env=env), 2, "configuration-unavailable")

    def test_disconnected_database_fails_without_logging_credentials(self):
        env = {**self.env, "DATABASE_URL": "postgresql://PRIVATE_USER:PRIVATE_PASSWORD@/PRIVATE_DATABASE"
               f"?host={self.backup.parent}/missing-socket"}
        result = self.invoke(BEFORE, AFTER, env=env)
        self.completion(result, 1, "failed")
        for private in ("PRIVATE_USER", "PRIVATE_PASSWORD", "PRIVATE_DATABASE", "missing-socket"):
            self.assertNotIn(private.encode(), result.stderr)

    def test_stalled_stderr_bounds_exit_and_recovers_the_completion(self):
        read_fd, write_fd = os.pipe()
        self.addCleanup(os.close, read_fd)
        self.addCleanup(os.close, write_fd)
        os.set_blocking(write_fd, False)
        while True:
            try:
                os.write(write_fd, b"x" * 4096)
            except BlockingIOError:
                break
        started = time.monotonic()
        process = subprocess.Popen([TOOL], stdout=subprocess.PIPE, stderr=write_fd, env=self.env)
        self.addCleanup(self.finish_process, process)
        self.assertEqual(process.wait(timeout=5), 2)
        self.assertLess(time.monotonic() - started, 3.5)
        output = process.stdout.read()
        emergency = self.backup.read_bytes()
        self.completion(subprocess.CompletedProcess(process.args, process.returncode, output, emergency),
                        2, "invalid-arguments")
        self.assertIn(b"recovered=1 dropped=1 lost=0 signal=0", emergency)


@unittest.skipUnless(os.environ.get("WM_PG_TEST"), "SKIP: set WM_PG_TEST and DATABASE_URL for Postgres cases")
class PostgresTest(ToolTest):
    def sql(self, statement):
        result = subprocess.run(["psql", self.env["DATABASE_URL"], "-XAtq", "-v", "ON_ERROR_STOP=1"],
                                input=statement, capture_output=True, text=True, timeout=10, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def setUp(self):
        super().setUp()
        self.assertTrue(self.env.get("DATABASE_URL"), "WM_PG_TEST requires DATABASE_URL")
        original = self.sql("SELECT quote_literal(epoch) FROM sync_meta;")
        self.assertTrue(original, "DATABASE_URL needs schema.sql and its singleton sync_meta row")
        self.schema = f"ep_sync_epoch_{os.getpid()}"
        self.sql(f"CREATE SCHEMA {self.schema};")
        self.addCleanup(self.sql, f"DROP SCHEMA {self.schema} CASCADE;")
        self.addCleanup(self.sql, f"INSERT INTO sync_meta(epoch) VALUES ({original}) "
                        "ON CONFLICT (one) DO UPDATE SET epoch = excluded.epoch;")
        self.sql(f"""
            UPDATE sync_meta SET epoch = '{BEFORE}';
            CREATE TABLE {self.schema}.updates (epoch text);
            CREATE FUNCTION {self.schema}.record() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                INSERT INTO {self.schema}.updates VALUES (NEW.epoch);
                IF current_setting('application_name') = '{self.schema}_crash' THEN
                    PERFORM pg_sleep(30);
                END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER {self.schema} AFTER UPDATE ON sync_meta
                FOR EACH ROW EXECUTE FUNCTION {self.schema}.record();
        """)

    def state(self):
        return self.sql(f"SELECT epoch, (SELECT count(*) FROM {self.schema}.updates) FROM sync_meta;")

    def test_rotation_retry_and_conflicting_target_write_exactly_once(self):
        self.completion(self.invoke(BEFORE, AFTER), 0, "ok")
        self.assertEqual(self.state(), f"{AFTER}|1")
        self.completion(self.invoke(BEFORE, AFTER), 0, "already-applied")
        self.completion(self.invoke(BEFORE, OTHER), 2, "epoch-mismatch")
        self.assertEqual(self.state(), f"{AFTER}|1")

    def test_concurrent_identical_attempts_write_exactly_once(self):
        processes = []
        for _ in range(2):
            process = subprocess.Popen([TOOL, BEFORE, AFTER], stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, env=self.env)
            self.addCleanup(self.finish_process, process)
            processes.append(process)
        outcomes = []
        for process in processes:
            output, error = process.communicate(timeout=10)
            record = [json.loads(match) for match in WRITE.findall(error)]
            self.assertEqual(len(record), 1, error.decode())
            outcomes.append(record[0]["outcome"])
            self.completion(subprocess.CompletedProcess(process.args, process.returncode, output, error),
                            0, record[0]["outcome"])
        self.assertEqual(sorted(outcomes), ["already-applied", "ok"])
        self.assertEqual(self.state(), f"{AFTER}|1")

    def test_missing_singleton_fails_without_creating_an_epoch(self):
        self.sql("DELETE FROM sync_meta;")
        self.completion(self.invoke(BEFORE, AFTER), 1, "failed")
        self.assertEqual(self.state(), "")
        self.assertEqual(self.sql(f"SELECT count(*) FROM {self.schema}.updates;"), "0")

    def test_statement_timeout_rolls_back_and_can_be_retried(self):
        holder = subprocess.Popen(["psql", self.env["DATABASE_URL"], "-XAtq", "-v", "ON_ERROR_STOP=1"],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=self.env)
        self.addCleanup(self.finish_process, holder)
        holder.stdin.write("BEGIN; SELECT 1 FROM sync_meta FOR UPDATE;\n")
        holder.stdin.flush()
        self.assertTrue(select.select([holder.stdout], [], [], 5)[0], "row lock was not acquired")
        self.assertEqual(holder.stdout.readline().strip(), "1")
        started = time.monotonic()
        self.completion(self.invoke(BEFORE, AFTER), 1, "failed")
        self.assertGreaterEqual(time.monotonic() - started, 4)
        self.assertEqual(self.state(), f"{BEFORE}|0")
        holder.communicate("ROLLBACK;\n", timeout=5)
        self.assertEqual(holder.returncode, 0)
        self.completion(self.invoke(BEFORE, AFTER), 0, "ok")
        self.assertEqual(self.state(), f"{AFTER}|1")

    def test_crash_after_update_rolls_back_and_can_be_retried(self):
        application = f"{self.schema}_crash"
        process = subprocess.Popen([TOOL, BEFORE, AFTER], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env={**self.env, "PGAPPNAME": application})
        self.addCleanup(self.finish_process, process)
        deadline = time.monotonic() + 4
        while self.sql("SELECT count(*) FROM pg_stat_activity "
                       f"WHERE application_name = '{application}' AND wait_event = 'PgSleep';") != "1":
            self.assertIsNone(process.poll(), "tool exited before its uncommitted update")
            self.assertLess(time.monotonic(), deadline, "tool never reached its uncommitted update")
            time.sleep(0.05)
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, -signal.SIGTERM)
        self.assertEqual(self.state(), f"{BEFORE}|0")
        self.completion(self.invoke(BEFORE, AFTER), 0, "ok")
        self.assertEqual(self.state(), f"{AFTER}|1")


if __name__ == "__main__":
    unittest.main()
