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
import textwrap
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "deploy/deploy-production.sh"


def server_config(environment=".env"):
    env = dict(line.split("=", 1) for line in Path(environment).read_text().splitlines() if "=" in line)
    return {"image": env.get("SERVER_IMAGE", "ghcr.io/neigrok/windmill-monorepo:" + env["IMAGE_TAG"]), "environment": {
        "AI_ALLOWANCES_ENABLED": env.get("AI_ALLOWANCES_ENABLED", "false"),
        "COACH_MAX_OUTPUT_TOKENS": env.get("COACH_MAX_OUTPUT_TOKENS", "2000"),
        "AI_INSTALLATIONS_ENABLED": env.get("AI_INSTALLATIONS_ENABLED", "false"),
        "AI_INSTALLATION_PROXY_MODE": env.get("AI_INSTALLATION_PROXY_MODE", "cloudflare"),
        "AI_INSTALLATION_IP_HMAC_KEY": env.get("AI_INSTALLATION_IP_HMAC_KEY", ""),
        "POSTGRES_PASSWORD": env["POSTGRES_PASSWORD"]}}


def compose(state, arguments):
    command = arguments[1:]
    environment = command[1] if command[0] == "--env-file" else ".env"
    while command[0] in ("--env-file", "-f"):
        command = command[2:]
    if command == ["version"]:
        return 1 if state.get("composeUnavailable") else 0, ""
    if command in (["config", "-q"], ["pull"]):
        return 1 if state.get("failAt") == command[0] else 0, ""
    if command == ["config", "--format", "json"]:
        return 0, json.dumps({"services": {"server": server_config(environment),
            "migrate": {"image": state.get("migrationImage", server_config(environment)["image"])}}})
    if command == ["ps", "-q", "server"]:
        return 0, "server-container"
    if command[0] == "up":
        state["promoted"] = True
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
    server = command[3:] if command[:3] == ["exec", "-T", "server"] else None
    if server and server[0] == "curl":
        schema = int(next(item.split(": ")[1] for item in server if item.startswith("Sync-Schema: ")))
        if schema == 2147483647:
            if state.get("liveUnavailable"):
                return 1, "PRIVATE_DEPLOY_SECRET"
            return 0, json.dumps(state.get("liveCompatibility", {"schema": 7, "minSchema": 4})) + "\n200"
        if state.get("healthFailures", 0):
            state["healthFailures"] -= 1
            return 1, "PRIVATE_DEPLOY_SECRET"
        if state.get("healthResponses"):
            return 0, "{}\n" + state["healthResponses"].pop(0)
        if state.get("unhealthy"):
            return 1, "PRIVATE_DEPLOY_SECRET"
        current = state.get("runtimeCompatibility", state.get("candidateMetadata", {"schema": 7, "minSchema": 4}))
        if schema < current["minSchema"]:
            status = state.get("oldSchemaStatus", 426)
            error = state.get("oldSchemaError", "upgrade-required")
            return 0, json.dumps({"epoch": "test-epoch", "error": error, "serverTime": 1}) + "\n" + str(status)
        return 0, json.dumps(current) + "\n200"
    if server and server[:3] == ["sh", "-eu", "-c"]:
        if server[-1] == "installation-key-present":
            key = state.get("serverEnvironment", {}).get("AI_INSTALLATION_IP_HMAC_KEY", server_config()["environment"]["AI_INSTALLATION_IP_HMAC_KEY"])
            return (0, "") if 32 <= len(key) <= 1024 else (1, "PRIVATE_DEPLOY_SECRET")
        key, expected = server[-2:]
        actual = state.get("serverEnvironment", {}).get(key, server_config()["environment"][key])
        return (0, "") if actual == expected else (1, "PRIVATE_DEPLOY_SECRET")
    raise AssertionError("unmodeled docker command: " + repr(arguments))


def docker_shim(arguments):
    path = Path(os.environ["WM_DEPLOY_STATE"])
    state = json.loads(path.read_text())
    state["commands"].append(arguments)
    if arguments[:3] == ["compose", "up", "-d"] and state.pop("killAt", None) == "up":
        path.write_text(json.dumps(state))
        os.kill(os.getppid(), signal.SIGKILL)
        return 0
    if arguments[:3] == ["inspect", "--format", '{"image":{{json .Config.Image}},"id":{{json .Image}}}']:
        status, output = 0, json.dumps({"image": state.get("serverImage", server_config()["image"]),
                                      "id": state.get("serverImageId", "sha256:" + "a" * 64)})
    elif arguments[:4] == ["image", "inspect", "--format", "{{.Id}}"]:
        status, output = 0, state.get("candidateImageId", "sha256:" + "a" * 64)
    elif arguments[:2] == ["run", "--rm"]:
        status, output = (1, "PRIVATE_DEPLOY_SECRET") if state.get("missingMetadata") else (
            0, json.dumps(state.get("candidateMetadata", {"schema": 7, "minSchema": 4})))
    else:
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
        (self.work / "sync-cutover.json").write_text(json.dumps({
            "mode": "automatic", "oldMinimum": "", "newMinimum": "", "imageId": ""}) + "\n")

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
                         (0, "PASS deployed: immutable image, sync compatibility, process environment and Caddy verified; DB password preserved\n", ""))
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\nPOSTGRES_PASSWORD=live-secret\nSERVER_IMAGE=sha256:" + "a" * 64 + "\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "Caddyfile": "# candidate Caddyfile\n"})
        state = self.state()
        self.assertEqual([command for command in state.pop("commands") if command[:2] == ["compose", "up"]], [
            ["compose", "up", "-d", "--pull", "never"],
            ["compose", "up", "-d", "--no-deps", "--force-recreate", "--pull", "never", "caddy"]])
        self.assertEqual(state, {"caddyMount": "# candidate Caddyfile\n",
                                 "caddyActive": {"file": "# candidate Caddyfile\n"}, "promoted": True})
        self.assertEqual(list(self.temporary.iterdir()), [])

    def approve(self, old, new, image_id=None):
        (self.work / "rendered.env").write_text("IMAGE_TAG=" + "b" * 40 + "\nPOSTGRES_PASSWORD=rendered-secret\nDOMAIN_APP=example.test\n")
        (self.work / "sync-cutover.json").write_text(json.dumps({
            "mode": "manual", "oldMinimum": str(old), "newMinimum": str(new),
            "imageId": image_id or "sha256:" + "a" * 64}) + "\n")

    def assert_preflight_refusal(self, reason):
        uploaded = self.files()
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", "FAIL " + reason + "\n"))
        self.assertEqual(self.files(), uploaded)
        self.assertFalse(any("up" in command for command in self.state()["commands"]))
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_unapproved_minimum_raises_and_lowers_leave_the_live_stack_unchanged(self):
        for proposed in ({"schema": 8, "minSchema": 8}, {"schema": 7, "minSchema": 3}):
            with self.subTest(proposed=proposed):
                self.state(candidateMetadata=proposed, commands=[])
                self.assert_preflight_refusal("sync minimum change requires a manual immutable image and exact old/new acknowledgement")

    def test_missing_or_invalid_candidate_metadata_refuses_without_leaking_output(self):
        for state in ({"missingMetadata": True}, {"candidateMetadata": {}},
                      {"candidateMetadata": {"schema": 8, "minSchema": 9}},
                      {"candidateMetadata": {"schema": 8, "minSchema": True}},
                      {"candidateMetadata": {"schema": "PRIVATE_DEPLOY_SECRET", "minSchema": 4}}):
            with self.subTest(state=state):
                self.state(missingMetadata=False, candidateMetadata={"schema": 7, "minSchema": 4}, commands=[])
                self.state(**state)
                self.assert_preflight_refusal("sync compatibility verification could not complete")

    def test_unreadable_live_compatibility_never_becomes_implicit_bootstrap(self):
        self.state(liveUnavailable=True)
        self.assert_preflight_refusal("sync compatibility verification could not complete")
        self.state(liveUnavailable=False, liveCompatibility={"schema": 7})
        self.assert_preflight_refusal("sync compatibility verification could not complete")
        (self.work / ".env").unlink()
        self.assert_preflight_refusal("live deployment environment is missing")

    def test_cutover_requires_the_exact_live_minimum_candidate_minimum_and_content_id(self):
        self.state(candidateMetadata={"schema": 8, "minSchema": 8})
        for old, new, image_id in ((3, 8, None), (4, 7, None), (4, 8, "sha256:" + "c" * 64)):
            with self.subTest(old=old, new=new, image_id=image_id):
                self.approve(old, new, image_id)
                self.assert_preflight_refusal("sync minimum change requires a manual immutable image and exact old/new acknowledgement")
        self.approve(4, 8)
        text = (self.work / "rendered.env").read_text().replace("b" * 40, "latest")
        (self.work / "rendered.env").write_text(text)
        self.assert_preflight_refusal("sync minimum change requires a manual immutable image and exact old/new acknowledgement")

    def test_migration_and_server_must_use_the_same_inspected_image(self):
        self.state(migrationImage="ghcr.io/neigrok/windmill-monorepo:other")
        self.assert_preflight_refusal("candidate server and migration images differ")

    def test_a_coordinated_cutover_pins_the_image_and_proves_schema_six_and_seven_refusals(self):
        self.state(candidateMetadata={"schema": 8, "minSchema": 8})
        self.approve(4, 8)
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0,
            "PASS deployed: immutable image, sync compatibility, process environment and Caddy verified; DB password preserved\n", ""))
        self.assertEqual((self.work / ".env").read_text(), "IMAGE_TAG=" + "b" * 40 +
                         "\nDOMAIN_APP=example.test\nPOSTGRES_PASSWORD=live-secret\nSERVER_IMAGE=sha256:" + "a" * 64 + "\n")
        commands = self.state()["commands"]
        metadata_read = next(command for command in commands if command[:2] == ["run", "--rm"])
        self.assertEqual(metadata_read, ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
                                        "--entrypoint", "cat", "sha256:" + "a" * 64, "/app/sync-compatibility.json"])
        self.assertLess(commands.index(metadata_read), commands.index(["compose", "up", "-d", "--pull", "never"]))
        probes = [command for command in commands if command[:5] == ["compose", "exec", "-T", "server", "curl"]]
        self.assertEqual([(next(item for item in command if item.startswith("Sync-Schema:")), command[-1])
                          for command in probes], [
            ("Sync-Schema: 2147483647", "http://127.0.0.1:8080/v1/sync/hello"),
            ("Sync-Schema: 8", "http://127.0.0.1:8080/v1/sync/hello")
        ] + [("Sync-Schema: " + str(schema), "http://127.0.0.1:8080/v1/sync/" + path +
              ("?schema=" + str(schema) if path == "live" else ""))
             for schema in (4, 5, 6, 7) for path in ("hello", "push", "pull", "live")])

    def test_fresh_host_needs_explicit_zero_minimum_bootstrap_acknowledgement(self):
        (self.work / ".env").unlink()
        (self.work / "docker-compose.yml").unlink()
        self.assert_preflight_refusal("sync minimum change requires a manual immutable image and exact old/new acknowledgement")
        self.approve(0, 4)
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("POSTGRES_PASSWORD=rendered-secret\n", (self.work / ".env").read_text())

    def test_a_server_that_accepts_or_mislabels_an_excluded_schema_fails_acceptance(self):
        for change in ({"oldSchemaStatus": 200}, {"oldSchemaError": "malformed"}):
            with self.subTest(change=change):
                self.upload_candidate()
                self.state(oldSchemaStatus=426, oldSchemaError="upgrade-required")
                self.state(**change)
                result = self.deploy()
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (1, "", "FAIL running server accepts an excluded sync schema\n"))

    def test_workflow_requires_an_image_commit_reachable_from_main_and_uses_its_sentry_release(self):
        workflow = SCRIPT.parents[2] / ".github/workflows/deploy.yml"
        text = workflow.read_text()
        start = text.index('          if [[ ! "$IMAGE_TAG"')
        end = text.index("          python3 - <<'PY'", start)
        guard = textwrap.dedent(text[start:end])
        root = self.bin.parent / "repository"
        root.mkdir()
        environment = {**os.environ, "GIT_AUTHOR_NAME": "Deploy test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
                       "GIT_COMMITTER_NAME": "Deploy test", "GIT_COMMITTER_EMAIL": "test@example.invalid"}
        def git(*arguments):
            return subprocess.run(["git", *arguments], cwd=root, env=environment, check=True,
                                  capture_output=True, text=True).stdout.strip()
        git("init", "-b", "main")
        git("commit", "--allow-empty", "-m", "main")
        main = git("rev-parse", "HEAD")
        git("update-ref", "refs/remotes/origin/main", main)
        git("switch", "-c", "unreleased")
        git("commit", "--allow-empty", "-m", "unreleased")
        other = git("rev-parse", "HEAD")
        for image, code, error in (
                (main, 0, ""), (other, 1, "Refusing deploy: the selected image commit must be reachable from origin/main.\n"),
                ("latest", 1, "Refusing deploy: image_tag must be a full commit SHA.\n")):
            result = subprocess.run(["bash", "-euc", guard], cwd=root,
                                    env={**environment, "IMAGE_TAG": image}, capture_output=True, text=True)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (code, "", error))
        release = next(line.strip() for line in text.splitlines() if line.strip().startswith("SENTRY_RELEASE:"))
        self.assertEqual(release, "SENTRY_RELEASE: ${{ inputs.image_tag || github.event.workflow_run.head_sha }}")

    def test_metadata_generation_matches_every_registry_in_the_compiled_composition(self):
        contract = self.bin.parent / "contract"
        contract.mkdir()
        (contract / "composition.json").write_text(json.dumps({"registries": ["gym.registry.json", "journal.registry.json"]}))
        for name in ("gym", "journal"):
            (contract / (name + ".registry.json")).write_text(json.dumps({"version": 8, "minVersion": 8}))
        output = self.bin.parent / "metadata.json"
        command = [sys.executable, str(SCRIPT.with_name("sync_compatibility.py")), "metadata", str(contract), str(output)]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr, output.read_text()),
                         (0, "", "", '{"schema": 8, "minSchema": 8}\n'))
        output.unlink()
        (contract / "journal.registry.json").write_text(json.dumps({"version": 7, "minVersion": 4}))
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, "", "FAIL sync compatibility verification could not complete\n"))
        self.assertFalse(output.exists())

    def test_an_unchanged_caddyfile_keeps_the_running_caddy(self):
        (self.work / "Caddyfile.next").write_text("# live Caddyfile\n")
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\nPOSTGRES_PASSWORD=live-secret\nSERVER_IMAGE=sha256:" + "a" * 64 + "\n",
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
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\nPOSTGRES_PASSWORD=live-secret\nSERVER_IMAGE=sha256:" + "a" * 64 + "\n",
                                        ".env.bak": "IMAGE_TAG=old\nPOSTGRES_PASSWORD=live-secret\n",
                                        "rendered.env": "IMAGE_TAG=new\nPOSTGRES_PASSWORD=rendered-secret\nDOMAIN_APP=example.test\n",
                                        "sync-cutover.json": json.dumps({"mode": "automatic", "oldMinimum": "", "newMinimum": "", "imageId": ""}) + "\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "Caddyfile": "# candidate Caddyfile\n"})
        self.assertEqual(self.state()["caddyMount"], "# live Caddyfile\n")
        self.upload_candidate()
        self.state(commands=[])
        retried = self.deploy()
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\nPOSTGRES_PASSWORD=live-secret\nSERVER_IMAGE=sha256:" + "a" * 64 + "\n",
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

    def test_enabled_allowances_and_custom_cap_match_the_running_process_after_readiness(self):
        with (self.work / "rendered.env").open("a") as out:
            out.write("AI_ALLOWANCES_ENABLED=true\nCOACH_MAX_OUTPUT_TOKENS=1536\n")
        self.state(healthFailures=1, healthResponses=["302"])
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (0, "PASS deployed: immutable image, sync compatibility, process environment and Caddy verified; DB password preserved\n", ""))
        self.assertEqual(sum(command[1:6] == ["exec", "-T", "server", "curl", "--silent"]
                             for command in self.state()["commands"]), 8)
        self.assertFalse(any(command[-1] == "installation-key-present" for command in self.state()["commands"]))
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_enabled_installations_require_a_private_key_and_prove_the_running_mode(self):
        with (self.work / "rendered.env").open("a") as out:
            out.write("AI_ALLOWANCES_ENABLED=true\nAI_INSTALLATIONS_ENABLED=true\nAI_INSTALLATION_IP_HMAC_KEY=" + "private_key_canary" * 4 + "\n")
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (0, "PASS deployed: immutable image, sync compatibility, process environment and Caddy verified; DB password preserved\n", ""))
        self.assertNotIn("private_key_canary", result.stdout + result.stderr)
        self.assertNotIn("private_key_canary", json.dumps(self.state()["commands"]))

    def test_enabled_installations_refuse_a_missing_running_key_without_logging_the_configured_key(self):
        with (self.work / "rendered.env").open("a") as out:
            out.write("AI_ALLOWANCES_ENABLED=true\nAI_INSTALLATIONS_ENABLED=true\nAI_INSTALLATION_IP_HMAC_KEY=" + "private_key_canary" * 4 + "\n")
        self.state(serverEnvironment={"AI_INSTALLATION_IP_HMAC_KEY": ""})
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, "", "FAIL running server installation network key is unavailable\n"))
        self.assertNotIn("private_key_canary", json.dumps(self.state()["commands"]))

    def test_anonymous_ai_refuses_missing_key_or_wrong_proxy_without_disclosing_configuration(self):
        for fields, failure in [
            ("AI_ALLOWANCES_ENABLED=true\nAI_INSTALLATIONS_ENABLED=true\n", "anonymous AI requires allowances and an installation network key"),
            ("AI_INSTALLATION_PROXY_MODE=direct\n", "invalid intended installation configuration")]:
            with self.subTest(fields=fields):
                self.upload_candidate()
                with (self.work / "rendered.env").open("a") as out:
                    out.write(fields)
                result = self.deploy()
                self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", "FAIL " + failure + "\n"))

    def test_runtime_mismatches_fail_without_exposing_configuration_or_command_output(self):
        for state, failure in [
            ({"serverImage": "PRIVATE_DEPLOY_SECRET"}, "running server image differs from intended image"),
            ({"serverImageId": "sha256:old"}, "running server image differs from intended image"),
            ({"serverEnvironment": {"AI_ALLOWANCES_ENABLED": "true"}}, "running server AI_ALLOWANCES_ENABLED differs from intended configuration"),
            ({"serverEnvironment": {"COACH_MAX_OUTPUT_TOKENS": "8000"}}, "running server COACH_MAX_OUTPUT_TOKENS differs from intended configuration"),
            ({"serverEnvironment": {"AI_INSTALLATIONS_ENABLED": "true"}}, "running server AI_INSTALLATIONS_ENABLED differs from intended configuration"),
            ({"serverEnvironment": {"AI_INSTALLATION_PROXY_MODE": "direct"}}, "running server AI_INSTALLATION_PROXY_MODE differs from intended configuration"),
            ({"unhealthy": True}, "running server did not advertise the candidate sync compatibility")]:
            with self.subTest(state=state):
                self.upload_candidate()
                self.state(serverImage="sha256:" + "a" * 64,
                           serverImageId="sha256:" + "a" * 64, serverEnvironment={}, unhealthy=False)
                self.state(**state)
                result = self.deploy()
                self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", "FAIL " + failure + "\n"))
                for secret in ("PRIVATE_DEPLOY_SECRET", "live-secret", "rendered-secret"):
                    self.assertNotIn(secret, result.stdout + result.stderr)
                self.assertEqual(list(self.temporary.iterdir()), [])


if __name__ == "__main__":
    if sys.argv[1:2] == ["--docker-shim"]:
        sys.exit(docker_shim(sys.argv[2:]))
    unittest.main()
