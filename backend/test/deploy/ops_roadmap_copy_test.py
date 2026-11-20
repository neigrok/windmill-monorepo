#!/usr/bin/env python3
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest


WORKFLOW = Path(__file__).resolve().parents[3] / ".github/workflows/ops-roadmap-copy.yml"
CANARIES = (b"PRIVATE_ROADMAP_CANARY", b"PRIVATE_ACCOUNT_CANARY", b"PRIVATE_SSH_KEY_CANARY")
FAKE_SSH = """#!/bin/sh
script=$(cat)
count=$(ls "$CALLS" | wc -l | tr -d ' ')
printf '%s\\n' "$script" > "$CALLS/$count.sh"
case "$script" in
  *pg_dump*) cat "$PAYLOADS/tables" ;;
  *) cat "$PAYLOADS/ids" ;;
esac
exit "${SSH_EXIT:-0}"
"""


def steps(text):
    return text.split("    steps:\n      - ", 1)[1].split("\n      - ")


class OpsRoadmapCopyTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.fixtures = self.root / "fixtures"
        for folder in ("fixtures/bin", "fixtures/calls", "fixtures/payloads", "work/.github/ops", "runner", "tmp"):
            (self.root / folder).mkdir(parents=True)
        ssh = self.fixtures / "bin/ssh"
        ssh.write_text(FAKE_SSH)
        ssh.chmod(0o755)
        self.tables = b"PGDMP" + bytes(range(256)) + b"PRIVATE_ROADMAP_CANARY"
        self.ids = b"account\tPRIVATE_ACCOUNT_CANARY\nshareCard\tt_0000000000000001\n"
        (self.fixtures / "payloads/tables").write_bytes(self.tables)
        (self.fixtures / "payloads/ids").write_bytes(self.ids)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=ops-roadmap-copy-test", "-keyout", str(self.fixtures / "owner.key.pem"),
                        "-out", str(self.root / "work/.github/ops/inventory-recipient.pem")],
                       check=True, capture_output=True)
        text = WORKFLOW.read_text()
        copy = next(step for step in steps(text) if step.startswith("name: Copy roadmap's rows"))
        self.script = textwrap.dedent(copy.split("        run: |\n", 1)[1])

    def run_copy(self, **environment):
        return subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", self.script],
                              cwd=self.root / "work", capture_output=True, text=True,
                              env={"PATH": str(self.fixtures / "bin") + os.pathsep + os.environ["PATH"],
                                   "RUNNER_TEMP": str(self.root / "runner"), "TMPDIR": str(self.root / "tmp"),
                                   "SSH_KEY": "PRIVATE_SSH_KEY_CANARY", "SSH_HOST": "vps.invalid", "SSH_USER": "deploy",
                                   "SSH_PORT": "", "CALLS": str(self.fixtures / "calls"),
                                   "PAYLOADS": str(self.fixtures / "payloads"), **environment})

    def assert_no_plaintext_left(self, result):
        for canary in CANARIES:
            self.assertNotIn(canary.decode(), result.stdout + result.stderr)
        for folder in ("work", "runner", "tmp"):
            for path in (self.root / folder).rglob("*"):
                if path.is_file():
                    for canary in CANARIES:
                        self.assertFalse(canary in path.read_bytes(), path)
        self.assertEqual(list((self.root / "tmp").iterdir()), [])

    def opened(self, copy, name, key):
        return subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-pass", "env:ROADMAP_COPY_KEY",
                               "-in", str(copy / name)], env={**os.environ, "ROADMAP_COPY_KEY": key},
                              check=True, capture_output=True).stdout

    def test_the_copy_reaches_the_runner_only_encrypted_and_prints_only_sizes_and_digests(self):
        result = self.run_copy()
        copy = self.root / "runner/roadmap-copy"
        names = ["key.pem", "tables.dump.enc", "ids.tsv.enc"]
        expected = "".join(f"{name}: {(copy / name).stat().st_size} bytes\n" for name in names)
        expected += "".join(f"{hashlib.sha256((copy / name).read_bytes()).hexdigest()}  {name}\n" for name in names)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, expected, ""))
        self.assertEqual(sorted(path.name for path in copy.iterdir()), sorted(names))
        self.assert_no_plaintext_left(result)
        key = subprocess.run(["openssl", "smime", "-decrypt", "-inform", "PEM", "-inkey", str(self.fixtures / "owner.key.pem"),
                              "-in", str(copy / "key.pem")], check=True, capture_output=True, text=True).stdout
        self.assertRegex(key, r"\A[0-9a-f]{64}\Z")
        self.assertEqual((self.opened(copy, "tables.dump.enc", key), self.opened(copy, "ids.tsv.enc", key)), (self.tables, self.ids))
        remote = [(self.fixtures / "calls" / f"{call}.sh").read_text() for call in range(2)]
        self.assertEqual([[line.strip() for line in script.splitlines() if "docker compose exec" in line] for script in remote], [
            ["docker compose exec -T -e 'PGOPTIONS=-c default_transaction_read_only=on' db sh -ec \\"],
            ["docker compose exec -T -e 'PGOPTIONS=-c default_transaction_read_only=on' db sh -ec \\"]])
        self.assertIn("exec pg_dump --username=\"$POSTGRES_USER\" --dbname=\"$POSTGRES_DB\" --format=custom", remote[0])
        self.assertEqual(re.findall(r"--table=(\S+?)'?(?=\s|$)", remote[0]), [
            "public.trees", "public.tree_nodes", "public.tree_edges", "public.tree_kinds", "public.node_progress",
            "public.tree_ops"])
        self.assertEqual(re.findall(r"select '(\w+)', (\S+) from (\w+)", remote[1]), [
            ("account", "id::text", "users"), ("shareCard", "tree_id", "tree_og_images"),
            ("shareVideo", "tree_id", "tree_og_videos"), ("roadmapScope", "key", "sync_scopes")])

    def test_a_copy_cut_short_prints_nothing_and_leaves_no_plaintext(self):
        result = self.run_copy(SSH_EXIT="255")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (255, "", ""))
        self.assertEqual(sorted(path.name for path in (self.root / "fixtures/calls").iterdir()), ["0.sh"])
        self.assert_no_plaintext_left(result)

    def test_it_runs_by_hand_under_the_deploy_lock_and_keeps_only_the_encrypted_copy_for_a_day(self):
        text = WORKFLOW.read_text()
        self.assertIn("\non:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\n"
                      "concurrency:\n  group: deploy-vps\n  cancel-in-progress: false\n\n"
                      "jobs:\n  copy:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n", text)
        self.assertEqual([step.split("\n", 1)[0] for step in steps(text)], [
            "uses: actions/checkout@v5", "name: Copy roadmap's rows, encrypted as they arrive",
            "name: Keep the encrypted copy for a day"])
        self.assertEqual(steps(text)[2], "name: Keep the encrypted copy for a day\n"
                         "        uses: actions/upload-artifact@v4\n"
                         "        with:\n"
                         "          name: roadmap-copy-${{ github.run_id }}\n"
                         "          path: ${{ runner.temp }}/roadmap-copy/\n"
                         "          retention-days: 1\n"
                         "          compression-level: 0\n"
                         "          if-no-files-found: error\n")
        self.assertIn('copy="$RUNNER_TEMP/roadmap-copy"\n', self.script)


if __name__ == "__main__":
    unittest.main()
