#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "deploy/deploy-production.sh"


def compose(state, arguments):
    command = arguments[1:]
    while command[0] in ("--env-file", "-f"):
        command = command[2:]
    if command == ["version"]:
        return 1 if state.get("composeUnavailable") else 0, ""
    if command in (["config", "-q"], ["pull"]):
        return 1 if state.get("failAt") == command[0] else 0, ""
    if command[0] == "up":
        if "--force-recreate" in command:
            if not state.get("staleMount"):
                state["caddyMount"] = Path("Caddyfile").read_text()
            if not state.get("staleConfig"):
                state["caddyActive"] = {"file": state["caddyMount"]}
        return 0, ""
    caddy = command[3:] if command[:3] == ["exec", "-T", "caddy"] else None
    if caddy == ["cat", "/etc/caddy/Caddyfile"]:
        return 0, state["caddyMount"]
    if caddy == ["caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]:
        if not state.get("staleConfig"):
            state["caddyActive"] = {"file": state["caddyMount"]}
        return 0, ""
    if caddy == ["caddy", "adapt", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]:
        return 0, json.dumps({"file": state["caddyMount"]})
    if caddy == ["wget", "-qO-", "http://127.0.0.1:2019/config/"]:
        return 0, json.dumps(state["caddyActive"])
    raise AssertionError("unmodeled docker command: " + repr(arguments))


def docker_shim(arguments):
    path = Path(os.environ["WM_DEPLOY_STATE"])
    state = json.loads(path.read_text())
    state["commands"].append(arguments)
    if arguments[:3] == ["compose", "up", "-d"] and state.pop("killAt", None) == "up":
        path.write_text(json.dumps(state))
        os.kill(os.getppid(), signal.SIGKILL)
        return 0
    status, output = compose(state, arguments)
    path.write_text(json.dumps(state))
    sys.stdout.write(output)
    return status


class DeployProductionTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="deploy-production-test-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.work = root / "windmill"
        self.work.mkdir()
        (self.work / ".env").write_text("IMAGE_TAG=old\nPOSTGRES_PASSWORD=live-secret\n")
        (self.work / "docker-compose.yml").write_text("# live compose\n")
        (self.work / "Caddyfile").write_text("# live Caddyfile\n")
        self.upload_candidate()
        self.state_path = root / "docker-state.json"
        self.state_path.write_text(json.dumps({"commands": [], "caddyMount": "# live Caddyfile\n",
                                               "caddyActive": {"file": "# live Caddyfile\n"}}))
        self.bin = root / "bin"
        self.bin.mkdir()
        shim = self.bin / "docker"
        shim.write_text("#!/bin/sh\nexec " + shlex.join([sys.executable, str(Path(__file__).resolve()), "--docker-shim"])
                        + ' "$@"\n')
        shim.chmod(0o700)
        self.temporary = root / "tmp"
        self.temporary.mkdir()

    def upload_candidate(self):
        (self.work / "rendered.env").write_text("IMAGE_TAG=new\nPOSTGRES_PASSWORD=rendered-secret\nDOMAIN_APP=example.test\n")
        (self.work / "docker-compose.next.yml").write_text("# candidate compose\n")
        (self.work / "Caddyfile.next").write_text("# candidate Caddyfile\n")

    def files(self):
        return {path.name: path.read_text() for path in self.work.iterdir()}

    def state(self, **changes):
        state = json.loads(self.state_path.read_text())
        if changes:
            state.update(changes)
            self.state_path.write_text(json.dumps(state))
        return state

    def deploy(self, path=None):
        environment = {**os.environ, "PATH": str(path) if path else str(self.bin) + os.pathsep + os.environ["PATH"],
                       "WM_DEPLOY_STATE": str(self.state_path), "TMPDIR": str(self.temporary)}
        return subprocess.run([shutil.which("bash"), str(SCRIPT)], cwd=self.work, env=environment,
                              capture_output=True, text=True, timeout=60)

    def test_promotes_the_candidate_keeps_the_database_password_and_recreates_a_changed_caddy(self):
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (0, "PASS deployed: environment rendered, DB password preserved, stack running\n", ""))
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\nPOSTGRES_PASSWORD=live-secret\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "Caddyfile": "# candidate Caddyfile\n"})
        self.assertEqual(self.state(), {
            "commands": [
                ["compose", "version"],
                ["compose", "--env-file", ".env.next", "-f", "docker-compose.next.yml", "config", "-q"],
                ["compose", "--env-file", ".env.next", "-f", "docker-compose.next.yml", "pull"],
                ["compose", "exec", "-T", "caddy", "cat", "/etc/caddy/Caddyfile"],
                ["compose", "up", "-d", "--pull", "never"],
                ["compose", "up", "-d", "--no-deps", "--force-recreate", "--pull", "never", "caddy"],
                ["compose", "exec", "-T", "caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile",
                 "--adapter", "caddyfile"],
                ["compose", "exec", "-T", "caddy", "cat", "/etc/caddy/Caddyfile"],
                ["compose", "exec", "-T", "caddy", "caddy", "adapt", "--config", "/etc/caddy/Caddyfile",
                 "--adapter", "caddyfile"],
                ["compose", "exec", "-T", "caddy", "wget", "-qO-", "http://127.0.0.1:2019/config/"]],
            "caddyMount": "# candidate Caddyfile\n",
            "caddyActive": {"file": "# candidate Caddyfile\n"}})
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_an_unchanged_caddyfile_keeps_the_running_caddy(self):
        (self.work / "Caddyfile.next").write_text("# live Caddyfile\n")
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\nPOSTGRES_PASSWORD=live-secret\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "Caddyfile": "# live Caddyfile\n"})
        self.assertNotIn("--force-recreate", [argument for command in self.state()["commands"] for argument in command])

    def assert_rejected_candidate_changes_nothing_live(self, failing, commands):
        uploaded = self.files()
        self.state(failAt=failing)
        result = self.deploy()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.files(), uploaded)
        self.assertEqual(self.state()["commands"], commands)

    def test_a_candidate_compose_that_fails_validation_changes_nothing_live(self):
        self.assert_rejected_candidate_changes_nothing_live("config", [
            ["compose", "version"],
            ["compose", "--env-file", ".env.next", "-f", "docker-compose.next.yml", "config", "-q"]])

    def test_a_candidate_whose_images_fail_to_pull_changes_nothing_live(self):
        self.assert_rejected_candidate_changes_nothing_live("pull", [
            ["compose", "version"],
            ["compose", "--env-file", ".env.next", "-f", "docker-compose.next.yml", "config", "-q"],
            ["compose", "--env-file", ".env.next", "-f", "docker-compose.next.yml", "pull"]])

    def test_a_recreated_caddy_still_serving_the_old_file_fails_the_deploy(self):
        self.state(staleMount=True)
        result = self.deploy()
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("PASS", result.stdout)
        self.assertIn(["compose", "up", "-d", "--no-deps", "--force-recreate", "--pull", "never", "caddy"],
                      self.state()["commands"])

    def test_a_caddy_that_never_loads_the_new_configuration_fails_the_deploy(self):
        self.state(staleConfig=True)
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, "", "FAIL running Caddy configuration differs from Caddyfile\n"))

    def test_retrying_the_same_candidate_after_a_kill_recreates_the_caddy_it_left_stale(self):
        self.state(killAt="up")
        killed = self.deploy()
        self.assertEqual(killed.returncode, -signal.SIGKILL)
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\nPOSTGRES_PASSWORD=live-secret\n",
                                        ".env.bak": "IMAGE_TAG=old\nPOSTGRES_PASSWORD=live-secret\n",
                                        "rendered.env": "IMAGE_TAG=new\nPOSTGRES_PASSWORD=rendered-secret\nDOMAIN_APP=example.test\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "Caddyfile": "# candidate Caddyfile\n"})
        self.assertEqual(self.state()["caddyMount"], "# live Caddyfile\n")
        self.upload_candidate()
        self.state(commands=[])
        retried = self.deploy()
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\nPOSTGRES_PASSWORD=live-secret\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "Caddyfile": "# candidate Caddyfile\n"})
        state = self.state()
        self.assertIn(["compose", "up", "-d", "--no-deps", "--force-recreate", "--pull", "never", "caddy"], state["commands"])
        self.assertEqual((state["caddyMount"], state["caddyActive"]),
                         ("# candidate Caddyfile\n", {"file": "# candidate Caddyfile\n"}))

    def assert_refused_before_any_change(self, path, refusal, commands):
        uploaded = self.files()
        result = self.deploy(path)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", refusal))
        self.assertEqual(self.files(), uploaded)
        self.assertEqual(self.state()["commands"], commands)

    def test_a_host_without_python3_refuses_before_any_change(self):
        limited = self.bin.parent / "limited"
        limited.mkdir()
        (limited / "docker").symlink_to(self.bin / "docker")
        self.assert_refused_before_any_change(limited, "FAIL required host command missing: python3\n", [])

    def test_a_host_without_docker_refuses_before_any_change(self):
        limited = self.bin.parent / "limited"
        limited.mkdir()
        (limited / "python3").symlink_to(shutil.which("python3"))
        self.assert_refused_before_any_change(limited, "FAIL required host command unavailable: docker compose\n", [])

    def test_a_host_without_docker_compose_refuses_before_any_change(self):
        self.state(composeUnavailable=True)
        self.assert_refused_before_any_change(None, "FAIL required host command unavailable: docker compose\n",
                                              [["compose", "version"]])


if __name__ == "__main__":
    if sys.argv[1:2] == ["--docker-shim"]:
        sys.exit(docker_shim(sys.argv[2:]))
    unittest.main()
