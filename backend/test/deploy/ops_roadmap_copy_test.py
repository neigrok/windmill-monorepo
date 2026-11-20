#!/usr/bin/env python3
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


REPOSITORY = Path(__file__).resolve().parents[3]
WORKFLOW = REPOSITORY / ".github/workflows/ops-roadmap-copy.yml"
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
RECORDING_OPENSSL = """#!/bin/sh
printf '%s\\n' "$*" >> "$OPENSSL_CALLS"
exec "$REAL_OPENSSL" "$@"
"""
FAKE_GH = """#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
case " $* " in
  *" --workflow $BUSY_WORKFLOW --status $BUSY_STATUS "*) echo 1 ;;
  *) echo 0 ;;
esac
"""
REMOTE_DUMP = """# The whole script is read before it runs, and nothing it starts can read the rest of it from stdin.
main() {
  cd ~/windmill
  docker compose exec -T -e 'PGOPTIONS=-c default_transaction_read_only=on' db sh -ec \\
    'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --lock-wait-timeout=10s \\
      --strict-names --table=public.trees --table=public.tree_nodes --table=public.tree_edges \\
      --table=public.tree_kinds --table=public.node_progress --table=public.tree_ops'
}
main < /dev/null
"""
REMOTE_IDS = """# The whole script is read before it runs, and nothing it starts can read the rest of it from stdin.
main() {
  cd ~/windmill
  docker compose exec -T -e 'PGOPTIONS=-c default_transaction_read_only=on -c lock_timeout=10s' db sh -ec \\
    'exec psql -XAtq -v ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' <<'SQL'
copy (select 'account', id::text from users
      where id in (select owner_id from trees) or id::text in (select user_id from node_progress)
         or id in (select owner from sync_scopes where kind <> 'product' or key like 'acct:%/roadmap')
      union all select 'shareCard', tree_id from tree_og_images
      union all select 'shareVideo', tree_id from tree_og_videos
      union all select 'roadmapScope', key from sync_scopes where kind <> 'product' or key like 'acct:%/roadmap') to stdout;
SQL
}
main < /dev/null
"""


def job(text, name):
    return text.split(f"\n  {name}:\n", 1)[1].split("\n\n  ", 1)[0]


def steps(block):
    return block.split("    steps:\n      - ", 1)[1].split("\n      - ")


def script(block, name):
    step = next(step for step in steps(block) if step.startswith(f"name: {name}"))
    return textwrap.dedent(step.split("        run: |\n", 1)[1])


def executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


class OpsRoadmapCopyTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.fixtures = self.root / "fixtures"
        for folder in ("fixtures/bin", "fixtures/payloads", "work/.github/ops"):
            (self.root / folder).mkdir(parents=True)
        executable(self.fixtures / "bin/ssh", FAKE_SSH)
        executable(self.fixtures / "bin/openssl", RECORDING_OPENSSL)
        self.tables = b"PGDMP" + bytes(range(256)) + b"PRIVATE_ROADMAP_CANARY"
        self.ids = b"account\tPRIVATE_ACCOUNT_CANARY\nshareCard\tt_0000000000000001\n"
        (self.fixtures / "payloads/tables").write_bytes(self.tables)
        (self.fixtures / "payloads/ids").write_bytes(self.ids)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=ops-roadmap-copy-test", "-keyout", str(self.fixtures / "owner.key.pem"),
                        "-out", str(self.root / "work/.github/ops/inventory-recipient.pem")],
                       check=True, capture_output=True)
        self.text = WORKFLOW.read_text()
        self.copy_script = script(job(self.text, "copy"), "Copy roadmap's rows")

    def run_copy(self, run, **environment):
        for folder in (f"runs/{run}/runner", f"runs/{run}/calls"):
            (self.root / folder).mkdir(parents=True)
        return subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", self.copy_script],
                              cwd=self.root / "work", capture_output=True, text=True,
                              env={"PATH": str(self.fixtures / "bin") + os.pathsep + os.environ["PATH"],
                                   "REAL_OPENSSL": shutil.which("openssl"),
                                   "OPENSSL_CALLS": str(self.root / f"runs/{run}/openssl-calls"),
                                   "RUNNER_TEMP": str(self.root / f"runs/{run}/runner"),
                                   "CALLS": str(self.root / f"runs/{run}/calls"), "PAYLOADS": str(self.fixtures / "payloads"),
                                   "SSH_KEY": "PRIVATE_SSH_KEY_CANARY", "SSH_HOST": "vps.invalid", "SSH_USER": "deploy",
                                   "SSH_PORT": "", **environment})

    def assert_no_plaintext_left(self, result, run):
        for canary in CANARIES:
            self.assertNotIn(canary.decode(), result.stdout + result.stderr)
        for folder in ("work", f"runs/{run}"):
            for path in (self.root / folder).rglob("*"):
                if path.is_file():
                    for canary in CANARIES:
                        self.assertFalse(canary in path.read_bytes(), path)

    def sealed_key(self, copy):
        return subprocess.run(["openssl", "smime", "-decrypt", "-inform", "PEM", "-inkey", str(self.fixtures / "owner.key.pem"),
                               "-in", str(copy / "key.pem")], check=True, capture_output=True, text=True).stdout

    def opened(self, copy, name, key):
        return subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-pass", "env:ROADMAP_COPY_KEY",
                               "-in", str(copy / name)], env={**os.environ, "ROADMAP_COPY_KEY": key},
                              check=True, capture_output=True).stdout

    def test_the_copy_reaches_the_runner_only_encrypted_under_a_key_of_its_own_and_prints_only_sizes_and_digests(self):
        result = self.run_copy("first")
        runner = self.root / "runs/first/runner"
        copy = runner / "roadmap-copy"
        names = ["key.pem", "tables.dump.enc", "ids.tsv.enc"]
        expected = "".join(f"{name}: {(copy / name).stat().st_size} bytes\n" for name in names)
        expected += "".join(f"{hashlib.sha256((copy / name).read_bytes()).hexdigest()}  {name}\n" for name in names)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, expected, ""))
        self.assertEqual(sorted(path.name for path in runner.iterdir()), ["roadmap-copy"])
        self.assertEqual({path.name: path.stat().st_mode & 0o777 for path in [copy, *copy.iterdir()]},
                         {"roadmap-copy": 0o700, **{name: 0o600 for name in names}})
        self.assert_no_plaintext_left(result, "first")
        key = self.sealed_key(copy)
        self.assertRegex(key, r"\A[0-9a-f]{64}\Z")
        self.assertEqual((self.opened(copy, "tables.dump.enc", key), self.opened(copy, "ids.tsv.enc", key)), (self.tables, self.ids))
        self.assertEqual((self.root / "runs/first/openssl-calls").read_text(), "".join(line + "\n" for line in [
            "rand -hex 32",
            f"smime -encrypt -aes256 -binary -outform PEM -out {copy}/key.pem .github/ops/inventory-recipient.pem",
            f"enc -aes-256-cbc -pbkdf2 -salt -pass env:ROADMAP_COPY_KEY -out {copy}/tables.dump.enc",
            f"enc -aes-256-cbc -pbkdf2 -salt -pass env:ROADMAP_COPY_KEY -out {copy}/ids.tsv.enc"]))
        self.assertEqual([(self.root / f"runs/first/calls/{call}.sh").read_text() for call in range(2)], [REMOTE_DUMP, REMOTE_IDS])
        self.assertEqual(self.run_copy("second").returncode, 0)
        self.assertNotEqual(self.sealed_key(self.root / "runs/second/runner/roadmap-copy"), key)

    def test_a_copy_cut_short_prints_nothing_and_leaves_no_plaintext(self):
        result = self.run_copy("cut", SSH_EXIT="255")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (255, "", ""))
        self.assertEqual(sorted(path.name for path in (self.root / "runs/cut/calls").iterdir()), ["0.sh"])
        self.assertEqual(sorted(path.name for path in (self.root / "runs/cut/runner").iterdir()), ["roadmap-copy"])
        self.assert_no_plaintext_left(result, "cut")

    def test_the_copy_waits_for_the_deploy_lock_only_once_no_deploy_holds_it_or_waits_for_it(self):
        executable(self.fixtures / "bin/gh", FAKE_GH)
        guard = script(job(self.text, "guard"), "Refuse while a deploy runs or waits to run")
        deploys = ["deploy.yml", "web.yml", "gym-backup.yml", "sync-digest-resum.yml"]
        statuses = ["queued", "in_progress", "waiting", "requested", "pending"]
        for busy, status, outcome in ((None, None, (0, "")), ("web.yml", "pending",
                                      (1, "Not during a deploy: web.yml has a run pending. Dispatch the copy again once it has finished.\n"))):
            with self.subTest(busy=busy):
                calls = self.root / f"gh-calls-{busy}"
                result = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", guard], cwd=REPOSITORY,
                                        capture_output=True, text=True,
                                        env={"PATH": str(self.fixtures / "bin") + os.pathsep + os.environ["PATH"],
                                             "GH_CALLS": str(calls), "GITHUB_REPOSITORY": "owner/repository",
                                             "BUSY_WORKFLOW": busy or "", "BUSY_STATUS": status or ""})
                self.assertEqual((result.returncode, result.stdout + result.stderr), outcome)
                asked = [line.split(" --workflow ", 1)[1].split(" --json", 1)[0] for line in calls.read_text().splitlines()]
                every = [f"{workflow} --status {each}" for workflow in sorted(deploys) for each in statuses]
                self.assertEqual(asked, every if busy is None else every[:every.index(f"{busy} --status {status}") + 1])

    def test_it_runs_by_hand_and_keeps_only_the_encrypted_copy_for_a_day(self):
        self.assertIn("\non:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n  actions: read\n\njobs:\n", self.text)
        self.assertNotIn("\nconcurrency:", self.text)
        self.assertEqual(job(self.text, "copy").split("    steps:\n", 1)[0], "    needs: guard\n    runs-on: ubuntu-latest\n"
                         "    timeout-minutes: 20\n    concurrency:\n      group: deploy-vps\n      cancel-in-progress: false\n")
        self.assertEqual([step.split("\n", 1)[0] for step in steps(job(self.text, "copy"))], [
            "uses: actions/checkout@v5", "name: Copy roadmap's rows, encrypted as they arrive",
            "name: Keep the encrypted copy for a day"])
        self.assertEqual(steps(job(self.text, "copy"))[2], "name: Keep the encrypted copy for a day\n"
                         "        uses: actions/upload-artifact@v4\n"
                         "        with:\n"
                         "          name: roadmap-copy-${{ github.run_id }}\n"
                         "          path: ${{ runner.temp }}/roadmap-copy/\n"
                         "          retention-days: 1\n"
                         "          compression-level: 0\n"
                         "          if-no-files-found: error\n")
        self.assertIn('copy="$RUNNER_TEMP/roadmap-copy"\n', self.copy_script)


if __name__ == "__main__":
    unittest.main()
