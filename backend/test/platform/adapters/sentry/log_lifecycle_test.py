import json
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import sys
import tempfile
import time
import unittest

MCP = sys.argv.pop(1)
SECRET = "PRIVATE_LOG_LIFECYCLE_CONTENT"
WRITE = re.compile(rb'write (\{[^\n]*\}) - ')


def no_core_dump():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


class LogLifecycleTest(unittest.TestCase):
    def environment(self, backup):
        return {**os.environ, "SENTRY_DSN": "", "WINDMILL_LOG_EMERGENCY_FILE": str(backup),
                "DATABASE_URL": "postgresql:///not_used?host=/tmp"}

    def refuse_create_tree(self, process, number):
        message = {"jsonrpc": "2.0", "id": number, "method": "tools/call",
                   "params": {"name": "create_tree", "arguments": {"title": {"secret": SECRET}}}}
        process.stdin.write(json.dumps(message).encode() + b"\n")
        process.stdin.flush()
        response = json.loads(process.stdout.readline())
        self.assertEqual(response["id"], number)
        self.assertTrue(response["result"]["isError"])

    def rejected_writes(self, fatal):
        with tempfile.TemporaryDirectory(prefix="windmill-log-lifecycle-") as directory:
            backup = Path(directory) / "emergency.log"
            process = subprocess.Popen([MCP], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, env=self.environment(backup),
                                       preexec_fn=no_core_dump)
            try:
                for number in range(500):
                    self.refuse_create_tree(process, number)
                if fatal:
                    process.send_signal(signal.SIGABRT)
                else:
                    process.stdin.close()
                self.assertEqual(process.wait(timeout=5), -signal.SIGABRT if fatal else 0)
                primary = process.stderr.read()
                emergency = backup.read_bytes()
                records = [json.loads(match) for match in WRITE.findall(primary + emergency)]
                completions = [record for record in records if record["operation"] == "mcp.roadmap_create_tree"]
                self.assertEqual(len(completions), 500)
                self.assertEqual(len({record["request_id"] for record in completions}), 500)
                self.assertTrue(all(record["outcome"] == "refused" for record in completions))
                self.assertNotIn(SECRET.encode(), primary + emergency)
                self.assertIn(b"lost=0", emergency)
                self.assertIn(f"signal={signal.SIGABRT if fatal else 0}".encode(), emergency)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                for stream in (process.stdin, process.stdout, process.stderr):
                    if not stream.closed:
                        stream.close()

    def test_stdio_eof_drains_all_500_completions_before_exit(self):
        self.rejected_writes(False)

    def test_fatal_signal_preserves_all_500_completions_and_loss_count(self):
        self.rejected_writes(True)

    def test_permanently_stalled_stderr_bounds_shutdown_and_recovers_the_completion(self):
        with tempfile.TemporaryDirectory(prefix="windmill-log-lifecycle-") as directory:
            backup = Path(directory) / "emergency.log"
            read_fd, write_fd = os.pipe()
            os.set_blocking(write_fd, False)
            try:
                while True:
                    try:
                        os.write(write_fd, b"x" * 4096)
                    except BlockingIOError:
                        break
                started = time.monotonic()
                process = subprocess.Popen([MCP], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=write_fd,
                                           env=self.environment(backup))
                try:
                    self.refuse_create_tree(process, 0)
                    process.stdin.close()
                    self.assertEqual(process.wait(timeout=5), 0)
                    self.assertLess(time.monotonic() - started, 3.5)
                    emergency = backup.read_bytes()
                    records = [json.loads(match) for match in WRITE.findall(emergency)]
                    self.assertEqual([(record["operation"], record["outcome"]) for record in records],
                                     [("mcp.roadmap_create_tree", "refused")])
                    self.assertNotIn(SECRET.encode(), emergency)
                    self.assertIn(b"recovered=1 dropped=1 lost=0 signal=0", emergency)
                    self.assertIn(b"log_queue_overflow dropped=1 total=1", emergency)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    for stream in (process.stdin, process.stdout):
                        if not stream.closed:
                            stream.close()
            finally:
                os.close(read_fd)
                os.close(write_fd)


if __name__ == "__main__":
    unittest.main()
