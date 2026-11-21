#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import os
import re
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
ROADMAP_ROOM = ["docker", "compose", "exec", "-T", "server", "sh", "-c",
                "if grep -Fzxq ROADMAP_ENGINE_ENABLED=1 /proc/1/environ; then echo on; else echo off; fi"]
PROVISIONED = "PASS subscriptions database: windmill_subscriptions provisioned, refused to the backend role (rules unchanged)"
DEPLOYED = ("PASS subscription service: healthy on its pinned image\n"
            "PASS AI database: windmill_ai provisioned, refused to other roles (rules unchanged)\n"
            "PASS AI service: healthy on its pinned image\n"
            "PASS deployed: immutable image, sync compatibility, process environment and Caddy verified; DB password preserved\n")
BACKEND_UP = ["compose", "up", "-d", "--pull", "never", "db", "migrate", "subscriptions-db", "server", "embedder", "caddy"]
# What a deploy reads before anything else, the switch being off: whether the database holds roadmap on the sync engine.
ROADMAP_READS = [["compose", "ps", "-q", "db"],
                 ["compose", "exec", "-T", "db", "psql", "--username=windmill", "--dbname=windmill", "-XAtq", "-v", "ON_ERROR_STOP=1",
                  "-c", "select to_regclass('public.sync_scopes') is not null"],
                 ["compose", "exec", "-T", "db", "psql", "--username=windmill", "--dbname=windmill", "-XAtq", "-v", "ON_ERROR_STOP=1",
                  "-c", "select exists (select 1 from sync_scopes where kind <> 'product' or key like 'acct:%/roadmap')"]]
SUBSCRIPTIONS_UP = ["compose", "up", "-d", "--no-deps", "--pull", "never", "subscriptions"]
DATABASE_START = [["compose", "up", "-d", "--no-deps", "--no-recreate", "db"],
                  ["compose", "exec", "-T", "db", "pg_isready", "--username=windmill", "--dbname=windmill"]]


def server_config(environment=".env", state=None):
    env = dict(line.split("=", 1) for line in Path(environment).read_text().splitlines() if "=" in line)
    switch = dict(line.split("=", 1) for line in Path("roadmap-engine.env").read_text().splitlines() if "=" in line)
    if (state or {}).get("composeIgnoresSwitch"):
        switch = {}
    return {"image": env.get("SERVER_IMAGE", "ghcr.io/neigrok/windmill-monorepo:" + env.get("BACKEND_TAG", "latest")), "environment": {
        "AI_ALLOWANCES_ENABLED": env.get("AI_ALLOWANCES_ENABLED", "false"),
        "COACH_MAX_OUTPUT_TOKENS": env.get("COACH_MAX_OUTPUT_TOKENS", "2000"),
        "AI_INSTALLATIONS_ENABLED": env.get("AI_INSTALLATIONS_ENABLED", "false"),
        "AI_INSTALLATION_PROXY_MODE": env.get("AI_INSTALLATION_PROXY_MODE", "cloudflare"),
        "AI_INSTALLATION_IP_HMAC_KEY": env.get("AI_INSTALLATION_IP_HMAC_KEY", ""),
        "POSTGRES_PASSWORD": env["POSTGRES_PASSWORD"], **switch}}


def compose(state, arguments):
    command = arguments[1:]
    environment = command[1] if command[0] == "--env-file" else ".env"
    while command[0] in ("--env-file", "-f"):
        command = command[2:]
    if command == ["version"]:
        return 1 if state.get("composeUnavailable") else 0, ""
    if command == ["config", "-q"]:
        return 1 if state.get("failAt") == "config" else 0, ""
    if command == ["pull", "ai"]:
        return 1 if state.get("aiImageMissing") else 0, ""
    if command == ["pull", "subscriptions"]:
        return 1 if state.get("subscriptionsImageMissing") else 0, ""
    if command[0] == "pull":
        return 1 if state.get("failAt") == "pull" else 0, ""
    if command == ["config", "--format", "json"]:
        env = dict(line.split("=", 1) for line in Path(environment).read_text().splitlines() if "=" in line)
        return 0, json.dumps({"services": {"server": server_config(environment, state),
            "migrate": {"image": state.get("migrationImage", server_config(environment)["image"])},
            "subscriptions": {"image": env.get("SUBSCRIPTIONS_IMAGE",
                                               "ghcr.io/neigrok/windmill-monorepo:subscriptions-" + env["IMAGE_TAG"])},
            "ai": {"image": env.get("AI_IMAGE", "ghcr.io/neigrok/windmill-monorepo:ai-" + env["IMAGE_TAG"])}}})
    if command == ["config", "--services"]:
        return 0, "db\nmigrate\nsubscriptions-db\nai-db\nserver\nembedder\nsubscriptions\nai\ncaddy\n"
    if command == ["ps", "-q", "server"]:
        return 0, "server-container"
    if command == ["ps", "-q", "db"]:
        return 0, "db-container" if state.get("dbRunning", True) else ""
    if command == DATABASE_START[0][1:]:
        state["dbRunning"] = True
        return 0, ""
    database = command[3:] if command[:3] == ["exec", "-T", "db"] else None
    if database and not state.get("dbRunning", True):
        return 1, "service \"db\" is not running"
    if database == DATABASE_START[1][4:]:
        return 0, "/var/run/postgresql:5432 - accepting connections\n"
    if database and database[0] == "psql" and database[-1] == "select to_regclass('public.sync_scopes') is not null":
        return (1, "PRIVATE_DEPLOY_SECRET") if state.get("databaseUnreadable") else (0, "t\n" if state.get("syncScopes", True) else "f\n")
    if database and database[0] == "psql" and "from sync_scopes where kind <> 'product' or key like 'acct:%/roadmap'" in database[-1]:
        return 0, "t\n" if state.get("roadmapOnEngine") else "f\n"
    if command == ["ps", "-aq", "ai-db"]:
        return 0, "ai-provisioning-container"
    if command == ["ps", "-aq", "ai"]:
        return 0, "ai-container"
    if command == ["logs", "--no-log-prefix", "--tail", "1", "ai-db"]:
        return 0, "PASS AI database: windmill_ai provisioned, refused to other roles (rules unchanged)\n"
    if command == ["up", "-d", "--no-deps", "--pull", "never", "ai"]:
        return 1 if state.get("aiUpFails") else 0, ""
    if command == ["up", "-d", "--no-deps", "--pull", "never", "ai-db"]:
        return 1 if state.get("aiProvisionUpFails") else 0, ""
    if command == ["ps", "-aq", "subscriptions-db"]:
        return 0, "provisioning-container"
    if command == ["ps", "-aq", "subscriptions"]:
        return 0, "subscriptions-container"
    if command == ["ps", "-q", "subscriptions"]:
        return 0, "subscriptions-container" if state.get("subscriptionsRunning", True) else ""
    if command == ["logs", "--no-log-prefix", "--tail", "1", "subscriptions-db"]:
        return 0, state.get("provisioningLine", PROVISIONED) + "\n"
    if command == SUBSCRIPTIONS_UP[1:]:
        return 1 if state.get("subscriptionsUpFails") else 0, ""
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
    if server and server[0] == "curl" and server[-1] == "http://127.0.0.1:8080/v1/socket":
        return 0, state.get("socketStatus", "410")
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
        if server[-1] == "roadmap-switch":
            intended = server_config()["environment"].get("ROADMAP_ENGINE_ENABLED", "")
            actual = state.get("serverEnvironment", {}).get("ROADMAP_ENGINE_ENABLED", intended)
            return (0, "") if actual == server[-2] else (1, "PRIVATE_DEPLOY_SECRET")
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
    elif arguments == ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", "ai-provisioning-container"]:
        status, output = 0, state.get("aiProvisioningOutcome", "exited 0")
    elif arguments == ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", "ai-container"]:
        health = state.get("aiHealth", ["healthy"])
        status, output = 0, health.pop(0) if len(health) > 1 else health[0]
    elif arguments == ["inspect", "--format", "{{.Image}}", "ai-container"]:
        status, output = 0, state.get("aiRunningId", "sha256:" + "d" * 64)
    elif arguments[:4] == ["image", "inspect", "--format", "{{.Id}}"] and ":ai-" in arguments[4]:
        status, output = 0, state.get("aiImageId", "sha256:" + "d" * 64)
    elif arguments == ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", "provisioning-container"]:
        status, output = 0, state.get("provisioningOutcome", "exited 0")
    elif arguments == ["inspect", "--format",
                       "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", "subscriptions-container"]:
        health = state.get("subscriptionsHealth", ["healthy"])
        status, output = 0, health.pop(0) if len(health) > 1 else health[0]
    elif arguments == ["inspect", "--format", "{{.Image}}", "subscriptions-container"]:
        status, output = 0, state.get("subscriptionsRunningId", "sha256:" + "b" * 64)
    elif arguments[:4] == ["image", "inspect", "--format", "{{.Id}}"] and arguments[4] in state.get("absentImages", []):
        status, output = 1, "Error: No such image: " + arguments[4]
    elif arguments[:4] == ["image", "inspect", "--format", "{{.Id}}"] and ":subscriptions-" in arguments[4]:
        status, output = 0, state.get("subscriptionsImageId", "sha256:" + "b" * 64)
    elif arguments[:4] == ["image", "inspect", "--format", "{{.Id}}"] and arguments[4].startswith("sha256:"):
        status, output = 0, arguments[4]
    elif arguments[:4] == ["image", "inspect", "--format", "{{.Id}}"]:
        status, output = 0, state.get("candidateImageId", "sha256:" + "a" * 64)
    elif arguments in (["image", "prune", "-af"], ["builder", "prune", "-af"]):
        status, output = 0, ""
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
        (self.work / "subscriptions-db").mkdir()
        (self.work / "subscriptions-db/provision.sh").write_text("# live provisioning\n")
        (self.work / "ai-db").mkdir()
        (self.work / "ai-db/provision.sh").write_text("# live AI provisioning\n")
        (self.work / "roadmap-engine.env").write_text("")
        (self.work / "maintenance").mkdir()
        self.ai_env = ("AI_DB_PASSWORD=" + "c" * 64 + "\nAI_PASS_KEYS={}\nAI_CARRY_KEY=" + "A" * 43 +
                       "\nAI_FUNDING_SECRET=" + "f" * 32 + "\nAI_OPERATOR_SECRET=" + "o" * 32 + "\n")
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
        # Every wait in the script is a loop of `sleep 1`; here a second passes at once.
        (self.bin / "sleep").write_text("#!/bin/sh\nexit 0\n")
        (self.bin / "sleep").chmod(0o700)
        self.temporary = root / "tmp"
        self.temporary.mkdir()

    def upload_candidate(self):
        (self.work / "rendered.env").write_text("IMAGE_TAG=new\nPOSTGRES_PASSWORD=rendered-secret\nDOMAIN_APP=example.test\n" + self.ai_env)
        (self.work / "docker-compose.next.yml").write_text("# candidate compose\n")
        (self.work / "Caddyfile.next").write_text("# candidate Caddyfile\n")
        (self.work / "subscriptions-db.next").mkdir(exist_ok=True)
        (self.work / "subscriptions-db.next/provision.sh").write_text("# candidate provisioning\n")
        (self.work / "ai-db.next").mkdir(exist_ok=True)
        (self.work / "ai-db.next/provision.sh").write_text("# candidate AI provisioning\n")
        (self.work / "sync-cutover.json").write_text(json.dumps({
            "mode": "automatic", "oldMinimum": "", "newMinimum": "", "imageId": ""}) + "\n")

    def files(self):
        return {path.name: path.read_text() if path.is_file() else
                {child.name: child.read_text() for child in path.iterdir()} for path in self.work.iterdir()}

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
                         (0, PROVISIONED + "\n" + DEPLOYED, ""))
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\n" + self.ai_env + "POSTGRES_PASSWORD=live-secret\nBACKEND_TAG=new\nSERVER_IMAGE=sha256:" + "a" * 64 +
                                        "\nSUBSCRIPTIONS_IMAGE=sha256:" + "b" * 64 + "\nAI_IMAGE=sha256:" + "d" * 64 + "\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "subscriptions-db": {"provision.sh": "# candidate provisioning\n"},
                                        "ai-db": {"provision.sh": "# candidate AI provisioning\n"},
                                        "Caddyfile": "# candidate Caddyfile\n", "roadmap-engine.env": "", "maintenance": {}})
        state = self.state()
        self.assertEqual([command for command in state.pop("commands") if command[:2] == ["compose", "up"]], [
            BACKEND_UP,
            ["compose", "up", "-d", "--no-deps", "--force-recreate", "--pull", "never", "caddy"],
            SUBSCRIPTIONS_UP,
            ["compose", "up", "-d", "--no-deps", "--pull", "never", "ai-db"],
            ["compose", "up", "-d", "--no-deps", "--pull", "never", "ai"]])
        self.assertEqual(state, {"caddyMount": "# candidate Caddyfile\n",
                                 "caddyActive": {"file": "# candidate Caddyfile\n"}, "promoted": True})
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_ai_image_is_pinned_before_promotion_and_starts_after_both_prior_services(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.state()["commands"]
        pin = commands.index(["image", "inspect", "--format", "{{.Id}}", "ghcr.io/neigrok/windmill-monorepo:ai-new"])
        self.assertLess(pin, commands.index(BACKEND_UP))
        ai_db = ["compose", "up", "-d", "--no-deps", "--pull", "never", "ai-db"]
        ai = ["compose", "up", "-d", "--no-deps", "--pull", "never", "ai"]
        self.assertLess(commands.index(SUBSCRIPTIONS_UP), commands.index(ai_db))
        self.assertLess(commands.index(ai_db), commands.index(ai))

    def test_ai_configuration_and_missing_image_refuse_before_live_mutation(self):
        for key in ("AI_DB_PASSWORD", "AI_CARRY_KEY", "AI_FUNDING_SECRET", "AI_OPERATOR_SECRET"):
            self.upload_candidate()
            path = self.work / "rendered.env"
            path.write_text("\n".join(line for line in path.read_text().splitlines() if not line.startswith(key + "=")) + "\n")
            self.assert_preflight_refusal("AI service configuration is missing or invalid")
        self.upload_candidate()
        self.state(aiImageMissing=True)
        self.assert_preflight_refusal("no AI service image could be pulled for this commit, and none runs here to keep")
        self.state(aiImageMissing=False, aiImageId="PRIVATE_AI_IMAGE")
        self.assert_preflight_refusal("candidate AI image has no immutable content ID")

    def test_ai_failures_leave_the_verified_backend_serving(self):
        for failure in ({"aiProvisioningOutcome": "exited 1"}, {"aiUpFails": True}, {"aiHealth": ["unhealthy"]}, {"aiRunningId": "sha256:" + "e" * 64}):
            self.upload_candidate()
            self.state(commands=[], aiProvisioningOutcome="exited 0", aiUpFails=False, aiHealth=["healthy"], aiRunningId="sha256:" + "d" * 64)
            self.state(**failure)
            result = self.deploy()
            self.assertEqual(result.returncode, 1)
            self.assertIn("the backend is deployed and serving", result.stderr)
            self.assertIn(BACKEND_UP, self.state()["commands"])
            self.assertIn(SUBSCRIPTIONS_UP, self.state()["commands"])
            self.assertNotIn("PRIVATE", result.stdout + result.stderr)

    def test_ai_image_absent_on_rollback_keeps_the_live_immutable_image(self):
        with (self.work / ".env").open("a") as file:
            file.write("AI_IMAGE=sha256:" + "e" * 64 + "\n")
        self.state(aiImageMissing=True, aiRunningId="sha256:" + "e" * 64)
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("AI_IMAGE=sha256:" + "e" * 64 + "\n", (self.work / ".env").read_text())

    def fingerprinted_deployment(self, changed, tag="new"):
        units = ("BACKEND", "SUBSCRIPTIONS", "AI")
        rendered = "".join(unit + "_INPUTS=" + ("9" if unit in changed else "0") * 64 + "\n" for unit in units)
        (self.work / ".env").write_text("IMAGE_TAG=" + "1" * 40 + "\nPOSTGRES_PASSWORD=live-secret\n" +
                                        "".join(unit + "_INPUTS=" + "0" * 64 + "\n" for unit in units) +
                                        "BACKEND_TAG=" + "1" * 40 + "\nSERVER_IMAGE=sha256:" + "e" * 64 +
                                        "\nSUBSCRIPTIONS_IMAGE=sha256:" + "c" * 64 + "\nAI_IMAGE=sha256:" + "f" * 64 + "\n")
        (self.work / "rendered.env").write_text("IMAGE_TAG=" + tag + "\n" + rendered +
                                                "POSTGRES_PASSWORD=rendered-secret\nDOMAIN_APP=example.test\n" + self.ai_env)
        (self.work / "Caddyfile.next").write_text((self.work / "Caddyfile").read_text())
        self.state(commands=[], serverImageId="sha256:" + ("a" if "BACKEND" in changed else "e") * 64,
                   subscriptionsRunningId="sha256:" + ("b" if "SUBSCRIPTIONS" in changed else "c") * 64,
                   aiRunningId="sha256:" + ("d" if "AI" in changed else "f") * 64)
        return rendered

    def test_a_deploy_replaces_only_the_units_whose_inputs_this_commit_changes(self):
        for changed in ({"AI"}, {"SUBSCRIPTIONS"}, {"BACKEND"}, {"BACKEND", "AI"}, {"BACKEND", "SUBSCRIPTIONS", "AI"}):
            with self.subTest(changed=sorted(changed)):
                self.upload_candidate()
                inputs = self.fingerprinted_deployment(changed)
                result = self.deploy()
                notes = (("" if "BACKEND" in changed else
                          "NOTE backend: nothing it is built from changed, so it keeps its image, built at " + "1" * 40 + "\n") +
                         ("" if "SUBSCRIPTIONS" in changed else "NOTE subscription service: nothing it is built from "
                          "changed, so it keeps its image, sha256:" + "c" * 64 + "\n") +
                         ("" if "AI" in changed else
                          "NOTE AI service: nothing it is built from changed, so it keeps its image, sha256:" + "f" * 64 + "\n"))
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, notes + PROVISIONED + "\n" + DEPLOYED, ""))
                self.assertEqual((self.work / ".env").read_text(), "IMAGE_TAG=new\n" + inputs + "DOMAIN_APP=example.test\n" +
                                 self.ai_env + "POSTGRES_PASSWORD=live-secret\nBACKEND_TAG=" +
                                 ("new" if "BACKEND" in changed else "1" * 40) +
                                 "\nSERVER_IMAGE=sha256:" + ("a" if "BACKEND" in changed else "e") * 64 +
                                 "\nSUBSCRIPTIONS_IMAGE=sha256:" + ("b" if "SUBSCRIPTIONS" in changed else "c") * 64 +
                                 "\nAI_IMAGE=sha256:" + ("d" if "AI" in changed else "f") * 64 + "\n")
                commands = self.state()["commands"]
                self.assertEqual([command[6:] for command in commands if command[5:6] == ["pull"]],
                                 ([BACKEND_UP[5:]] if "BACKEND" in changed else []) +
                                 ([["subscriptions"]] if "SUBSCRIPTIONS" in changed else []) +
                                 ([["ai"]] if "AI" in changed else []))
                self.assertEqual([command for command in commands if command[:2] == ["compose", "up"]], [
                    BACKEND_UP, SUBSCRIPTIONS_UP, ["compose", "up", "-d", "--no-deps", "--pull", "never", "ai-db"],
                    ["compose", "up", "-d", "--no-deps", "--pull", "never", "ai"]])

    def test_a_rollback_returns_each_unit_whose_inputs_differ_to_the_commit_it_names(self):
        older = "2" * 40
        inputs = self.fingerprinted_deployment({"BACKEND", "SUBSCRIPTIONS"}, tag=older)
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0,
            "NOTE AI service: nothing it is built from changed, so it keeps its image, sha256:" + "f" * 64 + "\n" +
            PROVISIONED + "\n" + DEPLOYED, ""))
        self.assertEqual((self.work / ".env").read_text(), "IMAGE_TAG=" + older + "\n" + inputs + "DOMAIN_APP=example.test\n" +
                         self.ai_env + "POSTGRES_PASSWORD=live-secret\nBACKEND_TAG=" + older + "\nSERVER_IMAGE=sha256:" +
                         "a" * 64 + "\nSUBSCRIPTIONS_IMAGE=sha256:" + "b" * 64 + "\nAI_IMAGE=sha256:" + "f" * 64 + "\n")
        self.assertEqual([command[4] for command in self.state()["commands"]
                          if command[:4] == ["image", "inspect", "--format", "{{.Id}}"]], [
            "ghcr.io/neigrok/windmill-monorepo:" + older, "ghcr.io/neigrok/windmill-monorepo:subscriptions-" + older,
            "sha256:" + "f" * 64, "sha256:" + "a" * 64])

    def test_a_backend_the_live_deployment_cannot_vouch_for_is_deployed_at_this_commit(self):
        for name, live, state in (
                ("its pinned image is gone", lambda text: text, {"absentImages": ["sha256:" + "e" * 64]}),
                ("no commit is recorded for it", lambda text: text.replace("BACKEND_TAG=" + "1" * 40 + "\n", ""), {}),
                ("no inputs are recorded for it", lambda text: text.replace("BACKEND_INPUTS=" + "0" * 64, "BACKEND_INPUTS="), {})):
            with self.subTest(name):
                self.upload_candidate()
                inputs = self.fingerprinted_deployment(set())
                (self.work / ".env").write_text(live((self.work / ".env").read_text()))
                self.state(**{"serverImageId": "sha256:" + "a" * 64, "absentImages": [], **state})
                result = self.deploy()
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0,
                    "NOTE subscription service: nothing it is built from changed, so it keeps its image, sha256:" + "c" * 64 +
                    "\nNOTE AI service: nothing it is built from changed, so it keeps its image, sha256:" + "f" * 64 + "\n" +
                    PROVISIONED + "\n" + DEPLOYED, ""))
                self.assertEqual((self.work / ".env").read_text(), "IMAGE_TAG=new\n" + inputs + "DOMAIN_APP=example.test\n" +
                                 self.ai_env + "POSTGRES_PASSWORD=live-secret\nBACKEND_TAG=new\nSERVER_IMAGE=sha256:" +
                                 "a" * 64 + "\nSUBSCRIPTIONS_IMAGE=sha256:" + "c" * 64 + "\nAI_IMAGE=sha256:" + "f" * 64 + "\n")
                self.assertEqual([command[6:] for command in self.state()["commands"] if command[5:6] == ["pull"]],
                                 [BACKEND_UP[5:]])

    def approve(self, old, new, image_id=None):
        (self.work / "rendered.env").write_text("IMAGE_TAG=" + "b" * 40 + "\nPOSTGRES_PASSWORD=rendered-secret\nDOMAIN_APP=example.test\n" + self.ai_env)
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
            PROVISIONED + "\n" + DEPLOYED, ""))
        self.assertEqual((self.work / ".env").read_text(), "IMAGE_TAG=" + "b" * 40 +
                         "\nDOMAIN_APP=example.test\n" + self.ai_env + "POSTGRES_PASSWORD=live-secret\nBACKEND_TAG=" + "b" * 40 +
                         "\nSERVER_IMAGE=sha256:" + "a" * 64 + "\nSUBSCRIPTIONS_IMAGE=sha256:" + "b" * 64 + "\nAI_IMAGE=sha256:" + "d" * 64 + "\n")
        commands = self.state()["commands"]
        metadata_read = next(command for command in commands if command[:2] == ["run", "--rm"])
        self.assertEqual(metadata_read, ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
                                        "--entrypoint", "cat", "sha256:" + "a" * 64, "/app/sync-compatibility.json"])
        self.assertLess(commands.index(metadata_read), commands.index(BACKEND_UP))
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

    def test_metadata_generation_matches_every_registry_in_the_compiled_composition(self):
        contract = self.bin.parent / "contract"
        contract.mkdir()
        names = ["alpha", "beta", "third-product3"]
        manifest = {"registries": [name + ".registry.json" for name in names]}
        (contract / "composition.json").write_text(json.dumps(manifest))
        for name in names:
            (contract / (name + ".registry.json")).write_text(json.dumps({"version": 8, "minVersion": 7}))
        output = self.bin.parent / "metadata.json"
        command = [sys.executable, str(SCRIPT.with_name("sync_compatibility.py")), "metadata", str(contract), str(output)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertEqual((result.returncode, result.stdout, result.stderr, output.read_text()),
                         (0, "", "", '{"schema": 8, "minSchema": 7}\n'))
        output.unlink()
        for interval in ({"version": 9, "minVersion": 7}, {"version": 8, "minVersion": 8}):
            (contract / "third-product3.registry.json").write_text(json.dumps(interval))
            result = subprocess.run(command, capture_output=True, text=True, timeout=20)
            self.assertEqual((result.returncode, result.stdout, result.stderr),
                             (1, "", "FAIL sync compatibility verification could not complete\n"))
            self.assertFalse(output.exists())
        (contract / "third-product3.registry.json").write_text(json.dumps({"version": 8, "minVersion": 7}))
        manifest["registries"].append("alpha.registry.json")
        (contract / "composition.json").write_text(json.dumps(manifest))
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, "", "FAIL sync compatibility verification could not complete\n"))
        self.assertFalse(output.exists())

    def test_an_unchanged_caddyfile_keeps_the_running_caddy(self):
        (self.work / "Caddyfile.next").write_text("# live Caddyfile\n")
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\n" + self.ai_env + "POSTGRES_PASSWORD=live-secret\nBACKEND_TAG=new\nSERVER_IMAGE=sha256:" + "a" * 64 +
                                        "\nSUBSCRIPTIONS_IMAGE=sha256:" + "b" * 64 + "\nAI_IMAGE=sha256:" + "d" * 64 + "\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "subscriptions-db": {"provision.sh": "# candidate provisioning\n"},
                                        "ai-db": {"provision.sh": "# candidate AI provisioning\n"},
                                        "Caddyfile": "# live Caddyfile\n", "roadmap-engine.env": "", "maintenance": {}})
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
            ["compose", "version"], *ROADMAP_READS,
            ["compose", "--env-file", ".env.next", "-f", "docker-compose.next.yml", "config", "-q"]])

    def test_a_candidate_whose_backend_images_fail_to_pull_changes_nothing_live(self):
        self.assert_rejected_candidate_changes_nothing_live("pull", [
            ["compose", "version"], *ROADMAP_READS,
            ["compose", "--env-file", ".env.next", "-f", "docker-compose.next.yml", "config", "-q"],
            ["compose", "--env-file", ".env.next", "-f", "docker-compose.next.yml", "config", "--services"],
            ["image", "prune", "-af"],
            ["builder", "prune", "-af"],
            ["compose", "--env-file", ".env.next", "-f", "docker-compose.next.yml", "pull"] + BACKEND_UP[5:]])

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
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\n" + self.ai_env + "POSTGRES_PASSWORD=live-secret\nBACKEND_TAG=new\nSERVER_IMAGE=sha256:" + "a" * 64 +
                                        "\nSUBSCRIPTIONS_IMAGE=sha256:" + "b" * 64 + "\nAI_IMAGE=sha256:" + "d" * 64 + "\n",
                                        ".env.bak": "IMAGE_TAG=old\nPOSTGRES_PASSWORD=live-secret\n",
                                        "rendered.env": "IMAGE_TAG=new\nPOSTGRES_PASSWORD=rendered-secret\nDOMAIN_APP=example.test\n" + self.ai_env,
                                        "sync-cutover.json": json.dumps({"mode": "automatic", "oldMinimum": "", "newMinimum": "", "imageId": ""}) + "\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "subscriptions-db": {"provision.sh": "# candidate provisioning\n"},
                                        "ai-db": {"provision.sh": "# candidate AI provisioning\n"},
                                        "Caddyfile": "# candidate Caddyfile\n", "roadmap-engine.env": "", "maintenance": {}})
        self.assertEqual(self.state()["caddyMount"], "# live Caddyfile\n")
        self.upload_candidate()
        self.state(commands=[])
        retried = self.deploy()
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\n" + self.ai_env + "POSTGRES_PASSWORD=live-secret\nBACKEND_TAG=new\nSERVER_IMAGE=sha256:" + "a" * 64 +
                                        "\nSUBSCRIPTIONS_IMAGE=sha256:" + "b" * 64 + "\nAI_IMAGE=sha256:" + "d" * 64 + "\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "subscriptions-db": {"provision.sh": "# candidate provisioning\n"},
                                        "ai-db": {"provision.sh": "# candidate AI provisioning\n"},
                                        "Caddyfile": "# candidate Caddyfile\n", "roadmap-engine.env": "", "maintenance": {}})
        state = self.state()
        self.assertIn(["compose", "up", "-d", "--no-deps", "--force-recreate", "--pull", "never", "caddy"], state["commands"])
        self.assertEqual((state["caddyMount"], state["caddyActive"]),
                         ("# candidate Caddyfile\n", {"file": "# candidate Caddyfile\n"}))

    def test_a_provisioning_that_fails_turns_the_run_red_with_the_backend_deployed(self):
        self.state(provisioningOutcome="exited 1",
                   provisioningLine="FAIL subscriptions database: the role or the database could not be created")
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1,
            "FAIL subscriptions database: the role or the database could not be created\n",
            "FAIL subscription database provisioning exited with code 1; the backend is deployed and serving\n"))
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\n" + self.ai_env + "POSTGRES_PASSWORD=live-secret\nBACKEND_TAG=new\nSERVER_IMAGE=sha256:" + "a" * 64 +
                                        "\nSUBSCRIPTIONS_IMAGE=sha256:" + "b" * 64 + "\nAI_IMAGE=sha256:" + "d" * 64 + "\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "subscriptions-db": {"provision.sh": "# candidate provisioning\n"},
                                        "ai-db": {"provision.sh": "# candidate AI provisioning\n"},
                                        "Caddyfile": "# candidate Caddyfile\n", "roadmap-engine.env": "", "maintenance": {}})
        self.assertIn(BACKEND_UP, self.state()["commands"])
        self.assertNotIn(SUBSCRIPTIONS_UP, self.state()["commands"])

    def test_the_subscription_service_is_pinned_before_promotion_and_starts_once_the_backend_and_its_database_pass(self):
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, PROVISIONED + "\n" + DEPLOYED, ""))
        commands = self.state()["commands"]
        pin = commands.index(["image", "inspect", "--format", "{{.Id}}", "ghcr.io/neigrok/windmill-monorepo:subscriptions-new"])
        provisioning = commands.index(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", "provisioning-container"])
        last_probe = max(index for index, command in enumerate(commands) if command[:5] == ["compose", "exec", "-T", "server", "curl"])
        self.assertLess(pin, commands.index(BACKEND_UP))
        self.assertLess(max(provisioning, last_probe), commands.index(SUBSCRIPTIONS_UP))
        health = ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
                  "subscriptions-container"]
        self.assertEqual(commands[commands.index(SUBSCRIPTIONS_UP):commands.index(SUBSCRIPTIONS_UP) + 4], [
            SUBSCRIPTIONS_UP, ["compose", "ps", "-aq", "subscriptions"], health,
            ["inspect", "--format", "{{.Image}}", "subscriptions-container"]])

    def test_a_failing_subscription_service_turns_the_run_red_and_is_not_rolled_back_with_the_backend_deployed(self):
        for state, failure in [
                ({"subscriptionsUpFails": True}, "subscription service did not start"),
                ({"subscriptionsHealth": ["starting", "starting", "unhealthy"]}, "subscription service was unhealthy after 2 s"),
                ({"subscriptionsHealth": ["starting"]}, "subscription service was starting after 60 s"),
                ({"subscriptionsRunningId": "sha256:" + "c" * 64},
                 "running subscription service image differs from intended image")]:
            with self.subTest(state=state):
                self.upload_candidate()
                self.state(commands=[], subscriptionsUpFails=False, subscriptionsHealth=["starting", "healthy"],
                           subscriptionsRunningId="sha256:" + "b" * 64)
                self.state(**state)
                result = self.deploy()
                self.assertEqual((result.returncode, result.stdout, result.stderr), (1, PROVISIONED + "\n",
                                 "FAIL " + failure + "; the backend is deployed and serving\n"))
                self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\n" + self.ai_env + "POSTGRES_PASSWORD=live-secret"
                                                "\nBACKEND_TAG=new\nSERVER_IMAGE=sha256:" + "a" * 64 + "\nSUBSCRIPTIONS_IMAGE=sha256:" + "b" * 64 + "\nAI_IMAGE=sha256:" + "d" * 64 + "\n",
                                                "docker-compose.yml": "# candidate compose\n",
                                                "subscriptions-db": {"provision.sh": "# candidate provisioning\n"},
                                        "ai-db": {"provision.sh": "# candidate AI provisioning\n"},
                                                "Caddyfile": "# candidate Caddyfile\n", "roadmap-engine.env": "", "maintenance": {}})
                commands = self.state()["commands"]
                self.assertIn(BACKEND_UP, commands)
                self.assertEqual({command[0] if command[0] == "inspect" else " ".join(command)
                                  for command in commands[commands.index(SUBSCRIPTIONS_UP) + 1:]},
                                 set() if state.get("subscriptionsUpFails") else {"compose ps -aq subscriptions", "inspect"})

    def test_a_commit_without_a_subscription_image_keeps_the_running_container_as_it_is(self):
        live = "sha256:" + "c" * 64
        kept = "PASS subscription service: its running container kept, not recreated, healthy on its image\n"
        deployed = DEPLOYED.split("\n", 1)[1]
        (self.work / ".env").write_text("IMAGE_TAG=old\nPOSTGRES_PASSWORD=live-secret\nSUBSCRIPTIONS_IMAGE=" + live + "\n")
        self.state(subscriptionsImageMissing=True, subscriptionsRunningId=live)
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0,
            "NOTE subscription service: no image could be pulled for this commit, so its running container is kept as "
            "it is, on " + live + "\n" + PROVISIONED + "\n" + kept + deployed, ""))
        self.assertEqual(self.files(), {".env": "IMAGE_TAG=new\nDOMAIN_APP=example.test\n" + self.ai_env + "POSTGRES_PASSWORD=live-secret"
                                        "\nBACKEND_TAG=new\nSERVER_IMAGE=sha256:" + "a" * 64 + "\nSUBSCRIPTIONS_IMAGE=" + live + "\nAI_IMAGE=sha256:" + "d" * 64 + "\n",
                                        "docker-compose.yml": "# candidate compose\n",
                                        "subscriptions-db": {"provision.sh": "# candidate provisioning\n"},
                                        "ai-db": {"provision.sh": "# candidate AI provisioning\n"},
                                        "Caddyfile": "# candidate Caddyfile\n", "roadmap-engine.env": "", "maintenance": {}})
        commands = self.state()["commands"]
        found = commands.index(["compose", "ps", "-q", "subscriptions"])
        self.assertEqual(commands[found + 1], ["inspect", "--format", "{{.Image}}", "subscriptions-container"])
        self.assertLess(found, commands.index(BACKEND_UP))
        self.assertFalse([command for command in commands if command[:2] == ["compose", "up"] and "subscriptions" in command])
        health = ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
                  "subscriptions-container"]
        provisioning = commands.index(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", "provisioning-container"])
        self.assertEqual(commands[provisioning + 2:provisioning + 4],
                         [health, ["inspect", "--format", "{{.Image}}", "subscriptions-container"]])
        self.assertEqual(commands[provisioning + 4],
                         ["compose", "up", "-d", "--no-deps", "--pull", "never", "ai-db"])

    def test_a_kept_subscription_container_that_is_not_healthy_turns_the_run_red(self):
        live = "sha256:" + "c" * 64
        (self.work / ".env").write_text("IMAGE_TAG=old\nPOSTGRES_PASSWORD=live-secret\nSUBSCRIPTIONS_IMAGE=" + live + "\n")
        self.state(subscriptionsImageMissing=True, subscriptionsRunningId=live, subscriptionsHealth=["unhealthy"])
        result = self.deploy()
        self.assertEqual((result.returncode, result.stderr),
                         (1, "FAIL subscription service was unhealthy after 0 s; the backend is deployed and serving\n"))
        self.assertFalse([command for command in self.state()["commands"]
                          if command[:2] == ["compose", "up"] and "subscriptions" in command])

    def test_a_commit_without_a_subscription_image_is_refused_where_no_service_runs_to_keep(self):
        for live in ("", "SUBSCRIPTIONS_IMAGE=sha256:" + "c" * 64 + "\n"):
            with self.subTest(live=live):
                (self.work / ".env").write_text("IMAGE_TAG=old\nPOSTGRES_PASSWORD=live-secret\n" + live)
                self.state(subscriptionsImageMissing=True, subscriptionsRunning=False, commands=[])
                self.assert_preflight_refusal(
                    "no subscription service image could be pulled for this commit, and none runs here to keep")

    def test_a_candidate_subscription_image_without_a_content_id_changes_nothing_live(self):
        self.state(subscriptionsImageId="PRIVATE_DEPLOY_SECRET")
        self.assert_preflight_refusal("candidate subscription image has no immutable content ID")

    def test_a_missing_provisioning_candidate_refuses_before_any_change(self):
        shutil.rmtree(self.work / "subscriptions-db.next")
        self.assert_refused_before_any_change(None, "FAIL candidate subscriptions-db folder is missing\n",
                                              [["compose", "version"]])

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
                         (0, PROVISIONED + "\n" + DEPLOYED, ""))
        self.assertEqual(sum(command[1:6] == ["exec", "-T", "server", "curl", "--silent"]
                             for command in self.state()["commands"]), 8)
        self.assertFalse(any(command[-1] == "installation-key-present" for command in self.state()["commands"]))
        self.assertEqual(list(self.temporary.iterdir()), [])

    def test_enabled_installations_require_a_private_key_and_prove_the_running_mode(self):
        with (self.work / "rendered.env").open("a") as out:
            out.write("AI_ALLOWANCES_ENABLED=true\nAI_INSTALLATIONS_ENABLED=true\nAI_INSTALLATION_IP_HMAC_KEY=" + "private_key_canary" * 4 + "\n")
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (0, PROVISIONED + "\n" + DEPLOYED, ""))
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

    def test_roadmap_s_switch_is_the_host_s_own_and_every_deploy_keeps_it_and_proves_it_on_the_running_server(self):
        (self.work / "roadmap-engine.env").write_text("ROADMAP_ENGINE_ENABLED=1\n")
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (0, "PASS roadmap: the server runs with ROADMAP_ENGINE_ENABLED=1, kept from roadmap-engine.env\n" +
                          PROVISIONED + "\n" + DEPLOYED, ""))
        self.assertEqual(self.files()["roadmap-engine.env"], "ROADMAP_ENGINE_ENABLED=1\n")
        self.assertNotIn("ROADMAP_ENGINE_ENABLED", self.files()[".env"])
        self.assertEqual([command[-2:] for command in self.state()["commands"] if command[-1] == "roadmap-switch"], [["1", "roadmap-switch"]])
        for switch, running in (("ROADMAP_ENGINE_ENABLED=1\n", ""), ("", "1")):
            with self.subTest(switch=switch):
                self.upload_candidate()
                (self.work / "roadmap-engine.env").write_text(switch)
                self.state(commands=[], serverEnvironment={"ROADMAP_ENGINE_ENABLED": running})
                result = self.deploy()
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (1, "", "FAIL running server ROADMAP_ENGINE_ENABLED differs from roadmap-engine.env\n"))
                self.assertEqual(self.files()["roadmap-engine.env"], switch)

    def test_a_database_holding_roadmap_on_the_engine_refuses_a_switch_lost_or_emptied_before_any_change(self):
        for state, reason in (({"roadmapOnEngine": True}, "the database holds roadmap on the sync engine, and roadmap-engine.env does "
                                                          "not say ROADMAP_ENGINE_ENABLED=1"),
                              ({"databaseUnreadable": True}, "whether the database holds roadmap on the sync engine could not be read")):
            for switch in ("", None):
                with self.subTest(state=state, switch=switch):
                    self.upload_candidate()
                    path = self.work / "roadmap-engine.env"
                    path.unlink(missing_ok=True)
                    if switch is not None:
                        path.write_text(switch)
                    self.state(**{"commands": [], "roadmapOnEngine": False, "databaseUnreadable": False, **state})
                    self.assert_preflight_refusal(reason)
        for switch in ("", None):
            with self.subTest(floor=True, switch=switch):
                self.upload_candidate()
                path = self.work / "roadmap-engine.env"
                path.unlink(missing_ok=True)
                if switch is not None:
                    path.write_text(switch)
                (self.work / "roadmap-engine.floor").write_text("c" * 40 + "\n")
                self.state(**{"commands": [], "roadmapOnEngine": False, "databaseUnreadable": False, "dbRunning": False})
                self.assert_preflight_refusal("roadmap-engine.floor says roadmap is on the sync engine here, and roadmap-engine.env "
                                              "does not say ROADMAP_ENGINE_ENABLED=1")
                (self.work / "roadmap-engine.floor").unlink()
        # A database that is down is started as it stands and asked; the deploy's own start comes after.
        self.upload_candidate()
        (self.work / "roadmap-engine.env").write_text("")
        uploaded = self.files()
        self.state(commands=[], roadmapOnEngine=True, databaseUnreadable=False, dbRunning=False, syncScopes=True)
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, "", "FAIL the database holds roadmap on the sync engine, and roadmap-engine.env does not say "
                                 "ROADMAP_ENGINE_ENABLED=1\n"))
        self.assertEqual(self.files(), uploaded)
        self.assertEqual(self.state()["commands"][1:], [ROADMAP_READS[0], *DATABASE_START, *ROADMAP_READS[1:]])
        for state in ({"dbRunning": False}, {"syncScopes": False}):
            with self.subTest(state=state):
                self.upload_candidate()
                (self.work / "roadmap-engine.env").write_text("")
                self.state(**{"commands": [], "roadmapOnEngine": False, "databaseUnreadable": False, "dbRunning": True,
                              "syncScopes": True, **state})
                result = self.deploy()
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, PROVISIONED + "\n" + DEPLOYED, ""))
                started = DATABASE_START if state.get("dbRunning") is False else []
                self.assertEqual(self.state()["commands"][1:len(started) + 3],
                                 [ROADMAP_READS[0], *started, ROADMAP_READS[1]])
        (self.work / "roadmap-engine.env").write_text("ROADMAP_ENGINE_ENABLED=1\n")
        self.upload_candidate()
        self.state(commands=[], roadmapOnEngine=True, dbRunning=True, syncScopes=True)
        self.assertEqual(self.deploy().returncode, 0)
        self.assertFalse(any(command[1:4] == ["exec", "-T", "db"] for command in self.state()["commands"]))

    def test_with_roadmap_on_the_engine_compose_must_read_the_switch_and_the_running_image_must_retire_the_socket(self):
        (self.work / "roadmap-engine.env").write_text("ROADMAP_ENGINE_ENABLED=1\n")
        for state, reason in (({"composeIgnoresSwitch": True}, "compose does not read roadmap-engine.env into the server"),
                              ({"socketStatus": "404"}, "the running server does not retire roadmap's socket while roadmap is on the sync engine")):
            with self.subTest(state=state):
                self.upload_candidate()
                self.state(**{"commands": [], "composeIgnoresSwitch": False, "socketStatus": "410", **state})
                result = self.deploy()
                self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", "FAIL " + reason + "\n"))

    def test_a_deploy_that_keeps_the_backend_runs_every_roadmap_guard_as_one_that_replaces_it(self):
        kept = ("NOTE backend: nothing it is built from changed, so it keeps its image, built at " + "1" * 40 + "\n" +
                "NOTE subscription service: nothing it is built from changed, so it keeps its image, sha256:" + "c" * 64 + "\n")
        for switch in ("", None):
            with self.subTest(floor=True, switch=switch):
                self.upload_candidate()
                self.fingerprinted_deployment({"AI"})
                path = self.work / "roadmap-engine.env"
                path.unlink(missing_ok=True)
                if switch is not None:
                    path.write_text(switch)
                (self.work / "roadmap-engine.floor").write_text("c" * 40 + "\n")
                self.assert_preflight_refusal("roadmap-engine.floor says roadmap is on the sync engine here, and roadmap-engine.env "
                                              "does not say ROADMAP_ENGINE_ENABLED=1")
        (self.work / "roadmap-engine.env").write_text("ROADMAP_ENGINE_ENABLED=1\n")
        for state, outcome in (({"socketStatus": "404"}, (1, kept, "FAIL the running server does not retire roadmap's socket "
                                                                    "while roadmap is on the sync engine\n")),
                               ({"composeIgnoresSwitch": True}, (1, kept, "FAIL compose does not read roadmap-engine.env into "
                                                                          "the server\n")),
                               ({}, (0, kept + "PASS roadmap: the server runs with ROADMAP_ENGINE_ENABLED=1, kept from "
                                           "roadmap-engine.env\n" + PROVISIONED + "\n" + DEPLOYED, ""))):
            with self.subTest(state=state):
                self.upload_candidate()
                self.fingerprinted_deployment({"AI"})
                self.state(**{"composeIgnoresSwitch": False, "socketStatus": "410", **state})
                result = self.deploy()
                self.assertEqual((result.returncode, result.stdout, result.stderr), outcome)

    def test_a_host_without_roadmap_s_switch_gets_it_empty_and_one_holding_anything_else_is_refused_before_any_change(self):
        (self.work / "roadmap-engine.env").unlink()
        (self.work / "maintenance").rmdir()
        result = self.deploy()
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, PROVISIONED + "\n" + DEPLOYED, ""))
        self.assertEqual((self.files()["roadmap-engine.env"], self.files()["maintenance"]), ("", {}))
        self.assertEqual([command[-2:] for command in self.state()["commands"] if command[-1] == "roadmap-switch"], [["", "roadmap-switch"]])
        for switch in ("ROADMAP_ENGINE_ENABLED=0\n", "ROADMAP_ENGINE_ENABLED=true\n", "ROADMAP_ENGINE_ENABLED=1\nPRIVATE_DEPLOY_SECRET=1\n"):
            with self.subTest(switch=switch):
                self.upload_candidate()
                (self.work / "roadmap-engine.env").write_text(switch)
                self.state(commands=[])
                self.assert_preflight_refusal("roadmap-engine.env holds something other than ROADMAP_ENGINE_ENABLED=1")

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


def web_shim(kind, arguments):
    path = Path(os.environ["WM_WEB_STATE"])
    state = json.loads(path.read_text())
    state["commands"].append([kind] + arguments)
    path.write_text(json.dumps(state))
    if kind == "docker" and arguments == ROADMAP_ROOM[1:]:
        if state.get("room") is None:
            return 1
        print(state["room"])
        return 0
    if kind == "docker":
        expected = ["compose", "exec", "-T", "server", "curl", "--silent", "--show-error", "--max-time", "2",
                    "--write-out", "\n%{http_code}", "-H", "Sync-Schema: 2147483647", "http://127.0.0.1:8080/v1/sync/hello"]
        if arguments != expected:
            raise AssertionError("web guard attempted a non-read operation")
        if state.get("failure"):
            print("PRIVATE_WEB_CANARY", file=sys.stderr)
            return 1
        print(state.get("body", json.dumps(state["hello"])) + "\n" + str(state.get("status", 200)))
        return 0
    remote = Path(os.environ["WM_WEB_REMOTE"])
    if kind == "ssh":
        command = arguments[-1]
        if command.startswith("cd ~/windmill && python3 - web-preflight "):
            return subprocess.run([sys.executable, "-", *shlex.split(command.split("python3 - ", 1)[1])],
                                  input=sys.stdin.read(), text=True, cwd=remote).returncode
        if command == "cd ~/windmill && " + shlex.join(ROADMAP_ROOM[:7]) + ' "' + ROADMAP_ROOM[7] + '"':
            if state.get("room") is None:
                return 1
            print(state["room"])
            return 0
        if command == "mkdir -p ~/windmill/web":
            (remote / "web").mkdir(exist_ok=True)
            return 0
        raise AssertionError("unmodeled web SSH command")
    if kind == "rsync":
        if arguments[:3] != ["-az", "--delete", "-e"] or arguments[-2:] != ["dist/", "fixture@host:windmill/web/"]:
            raise AssertionError("unmodeled web promotion")
        shutil.copyfile("dist/index.html", remote / "web/index.html")
        return 0
    raise AssertionError("unmodeled web deployment command")


class WebCompatibilityTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.remote = self.root / "remote"
        self.remote.mkdir()
        (self.remote / "web").mkdir()
        for name, contents in {"web/index.html": "compatible live web", ".env": "PRIVATE_WEB_CANARY",
                               "docker-compose.yml": "live compose", "sync-epoch": "retained epoch"}.items():
            (self.remote / name).write_text(contents)
        self.web = self.root / "checkout/web"
        (self.web / "dist").mkdir(parents=True)
        (self.web / "dist/index.html").write_text("candidate web")
        helper = self.web.parent / "backend/deploy/sync_compatibility.py"
        helper.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT.with_name("sync_compatibility.py"), helper)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("docker", "ssh", "rsync"):
            target = self.bin / name
            target.write_text("#!" + sys.executable + "\nimport runpy,sys\nsys.argv=[" + repr(str(Path(__file__).resolve())) +
                              ", '--web-shim', " + repr(name) + "]+sys.argv[1:]\nrunpy.run_path(sys.argv[0],run_name='__main__')\n")
            target.chmod(0o755)
        self.state = self.root / "state.json"
        self.environment = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                            "WM_WEB_STATE": str(self.state), "WM_WEB_REMOTE": str(self.remote),
                            "SSH_KEY": "PRIVATE_WEB_CANARY", "SSH_HOST": "host", "SSH_USER": "fixture", "SSH_PORT": "22",
                            "GITHUB_SHA": "b" * 40, "ROADMAP_ROOM": "off"}

    def block(self, name):
        text = (SCRIPT.parents[2] / ".github/workflows/web.yml").read_text()
        step = text.split("      - name: " + name + "\n", 1)[1]
        return textwrap.dedent(step.split("        run: |\n", 1)[1].split("\n      - ", 1)[0])

    def live_files(self):
        return {str(path.relative_to(self.remote)): path.read_bytes() for path in self.remote.rglob("*") if path.is_file()}

    def promote(self, hello, schema=10, minimum=10, **response):
        self.state.write_text(json.dumps({"commands": [], "hello": hello, "room": "off", **response}))
        (self.web / "web-sync-compatibility.json").write_text(json.dumps({"schema": schema, "minSchema": minimum}))
        return subprocess.run(["bash", "-euc", self.block("Rsync dist to the VPS")], cwd=self.web,
                              env=self.environment, capture_output=True, text=True)

    def test_incompatible_clients_leave_every_live_file_unchanged(self):
        before = self.live_files()
        for hello, schema, minimum in (({"schema": 8, "minSchema": 4}, 10, 10),
                                       ({"schema": 11, "minSchema": 11}, 10, 10)):
            with self.subTest(hello=hello):
                result = self.promote(hello, schema, minimum)
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (1, "", "HOLD web deployment: live backend and candidate client are incompatible\n"))
                self.assertEqual(self.live_files(), before)
                self.assertEqual([command[0] for command in json.loads(self.state.read_text())["commands"]], ["ssh", "docker"])

    def test_compatible_intervals_promote_only_after_the_anonymous_live_check(self):
        for hello, schema, minimum in (({"schema": 10, "minSchema": 10}, 10, 10),
                                       ({"schema": 11, "minSchema": 10}, 10, 10),
                                       ({"schema": 10, "minSchema": 4}, 9, 9)):
            with self.subTest(hello=hello):
                result = self.promote(hello, schema, minimum)
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (0, "PASS web deployment: live backend accepts the candidate sync client, roadmap's room off\n", ""))
                self.assertEqual([command[0] for command in json.loads(self.state.read_text())["commands"]],
                                 ["ssh", "docker", "docker", "ssh", "rsync"])
                self.assertEqual((self.remote / "web/index.html").read_text(), "candidate web")
                self.assertEqual((self.remote / ".env").read_text(), "PRIVATE_WEB_CANARY")
                self.assertEqual((self.remote / "sync-epoch").read_text(), "retained epoch")

    def test_missing_malformed_refused_or_unavailable_hello_holds_without_exposing_output(self):
        before = self.live_files()
        cases = [{"hello": {}}, {"hello": {"schema": True, "minSchema": 1}},
                 {"hello": {"schema": "10", "minSchema": 10}}, {"hello": {"schema": 10, "minSchema": 11}},
                 {"hello": {"schema": 10, "minSchema": 0}}, {"hello": {}, "body": "PRIVATE_WEB_CANARY"},
                 {"hello": {"schema": 10, "minSchema": 10}, "failure": True}]
        cases += [{"hello": {"schema": 10, "minSchema": 10}, "status": status} for status in (401, 426, 500, 503)]
        for fields in cases:
            with self.subTest(fields=fields):
                result = self.promote(**fields)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertIn("HOLD web deployment:", result.stderr)
                self.assertNotIn("PRIVATE_WEB_CANARY", result.stdout + result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(self.live_files(), before)
                self.assertEqual([command[0] for command in json.loads(self.state.read_text())["commands"]], ["ssh", "docker"])

    def test_a_build_takes_roadmap_s_room_from_the_running_server_and_the_preflight_holds_one_the_server_does_not_serve(self):
        text = (SCRIPT.parents[2] / ".github/workflows/web.yml").read_text()
        reading = text.split("      - name: Read roadmap's switch on the host\n", 1)[1].split("\n      - ", 1)[0]
        self.assertTrue(reading.startswith("        id: roadmap\n        if: github.event_name != 'pull_request'\n"))
        self.assertLess(text.index("name: Read roadmap's switch on the host"), text.index("      - name: Build\n"))
        self.assertIn("          VITE_ROADMAP_REPLICA_ROOM: ${{ steps.roadmap.outputs.room || 'off' }}\n        run: npm run build\n", text)
        self.assertIn("          ROADMAP_ROOM: ${{ steps.roadmap.outputs.room }}\n", text.split("      - name: Rsync dist to the VPS\n", 1)[1])
        output = self.root / "github-output"
        unread = (1, "FAIL the running server's roadmap switch could not be read\n", "")
        for room, outcome in (("off", (0, "Roadmap's room: off\n", "room=off\n")), ("on", (0, "Roadmap's room: on\n", "room=on\n")),
                              (None, unread), ("PRIVATE_WEB_CANARY", unread)):
            with self.subTest(room=room):
                output.write_text("")
                self.state.write_text(json.dumps({"commands": [], "room": room}))
                result = subprocess.run(["bash", "-euc", self.block("Read roadmap's switch on the host")], cwd=self.web,
                                        env={**self.environment, "GITHUB_OUTPUT": str(output)}, capture_output=True, text=True)
                self.assertEqual((result.returncode, result.stdout + result.stderr, output.read_text()), outcome)
        for serving, room, outcome in (("on", "off", "HOLD web deployment: the candidate's roadmap room is off and the running server's is on\n"),
                                       ("off", "on", "HOLD web deployment: the candidate's roadmap room is on and the running server's is off\n"),
                                       ("PRIVATE_WEB_CANARY", "on", "HOLD web deployment: sync compatibility could not be verified\n"),
                                       (None, "on", "HOLD web deployment: sync compatibility could not be verified\n")):
            with self.subTest(serving=serving, room=room):
                before = self.live_files()
                self.environment["ROADMAP_ROOM"] = room
                result = self.promote({"schema": 10, "minSchema": 10}, room=serving)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", outcome))
                self.assertEqual(self.live_files(), before)
        self.environment["ROADMAP_ROOM"] = "on"
        result = self.promote({"schema": 10, "minSchema": 10}, room="on")
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (0, "PASS web deployment: live backend accepts the candidate sync client, roadmap's room on\n", ""))
        self.assertEqual((self.remote / "web/index.html").read_text(), "candidate web")

    def test_invalid_candidate_interval_never_reaches_the_host(self):
        before = self.live_files()
        for schema, minimum in ((10, 11), (10, 0), (True, 1), ("PRIVATE_WEB_CANARY", 10)):
            with self.subTest(schema=schema, minimum=minimum):
                result = self.promote({"schema": 10, "minSchema": 10}, schema, minimum)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("PRIVATE_WEB_CANARY", result.stdout + result.stderr)
                self.assertEqual(json.loads(self.state.read_text())["commands"], [])
                self.assertEqual(self.live_files(), before)

    def test_pinned_artifact_records_the_source_composed_schema_and_every_dist_file_before_preflight(self):
        contract = self.web.parent / "packages/api-contract/sync"
        contract.mkdir(parents=True)
        (contract / "composition.json").write_text(json.dumps({"registries": ["gym.registry.json", "journal.registry.json"]}))
        for name in ("gym", "journal"):
            (contract / (name + ".registry.json")).write_text(json.dumps({"version": 10, "minVersion": 10}))
        (self.web / "dist/.retained").write_bytes(bytes([0, 128, 255]))
        result = subprocess.run(["bash", "-euc", self.block("Prepare pinned web release")], cwd=self.web,
                                env=self.environment, capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        release = json.loads((self.web / "web-release.json").read_text())
        self.assertEqual(release, {"source": "b" * 40, "compatibility": {"schema": 10, "minSchema": 10}, "files": [
            {"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in ((".retained", bytes([0, 128, 255])), ("index.html", b"candidate web"))]})
        text = (SCRIPT.parents[2] / ".github/workflows/web.yml").read_text()
        self.assertLess(text.index("name: Retain pinned web release"), text.index("name: Rsync dist to the VPS"))
        retained = text.split("      - name: Retain pinned web release\n", 1)[1].split("\n      - ", 1)[0]
        self.assertIn("name: web-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}", retained)
        for entry in ("web/dist/", "web/web-release.json", "web/web-sync-compatibility.json", "include-hidden-files: true", "if-no-files-found: error"):
            self.assertIn(entry, retained)
        promotion = text.split("      - name: Rsync dist to the VPS\n", 1)[1]
        self.assertIn("if: github.event_name != 'pull_request'", promotion)
        self.assertIn("concurrency:\n"
                      "  group: ${{ github.event_name == 'pull_request' && format('web-pr-{0}', github.ref) || 'deploy-vps' }}\n"
                      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n", text)

    def test_inconsistent_composed_metadata_or_an_empty_dist_cannot_be_retained_for_promotion(self):
        contract = self.web.parent / "packages/api-contract/sync"
        contract.mkdir(parents=True)
        (contract / "composition.json").write_text(json.dumps({"registries": ["gym.registry.json", "journal.registry.json"]}))
        (contract / "gym.registry.json").write_text(json.dumps({"version": 10, "minVersion": 10}))
        (contract / "journal.registry.json").write_text(json.dumps({"version": 9, "minVersion": 9}))
        result = subprocess.run(["bash", "-euc", self.block("Prepare pinned web release")], cwd=self.web,
                                env=self.environment, capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, "", "FAIL sync compatibility verification could not complete\n"))
        self.assertFalse((self.web / "web-release.json").exists())
        (contract / "journal.registry.json").write_text(json.dumps({"version": 10, "minVersion": 10}))
        (self.web / "dist/index.html").unlink()
        result = subprocess.run(["bash", "-euc", self.block("Prepare pinned web release")], cwd=self.web,
                                env=self.environment, capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, "", "FAIL web release has no files\n"))
        self.assertFalse((self.web / "web-release.json").exists())

    def test_a_dist_symlink_cannot_misdescribe_outside_bytes_as_a_retained_release(self):
        contract = self.web.parent / "packages/api-contract/sync"
        contract.mkdir(parents=True)
        (contract / "composition.json").write_text(json.dumps({"registries": ["gym.registry.json"]}))
        (contract / "gym.registry.json").write_text(json.dumps({"version": 10, "minVersion": 10}))
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "private.txt").write_text("PRIVATE_WEB_CANARY")
        before = self.live_files()
        link = self.web / "dist/linked"
        for target in (outside / "private.txt", outside, outside / "missing"):
            with self.subTest(target=target.name):
                link.symlink_to(target)
                result = subprocess.run(["bash", "-euc", self.block("Prepare pinned web release")], cwd=self.web,
                                        env=self.environment, capture_output=True, text=True)
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (1, "", "FAIL web release contains a symlink\n"))
                self.assertFalse((self.web / "web-release.json").exists())
                self.assertNotIn("PRIVATE_WEB_CANARY", result.stdout + result.stderr)
                self.assertEqual(self.live_files(), before)
                link.unlink()


class DeployWorkflowTest(unittest.TestCase):
    def test_the_shipped_composition_names_roadmap_at_its_interval(self):
        root = SCRIPT.parents[2]
        contract = root / "packages/api-contract/sync"
        work = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, work)
        output = work / "shipped.json"
        result = subprocess.run([sys.executable, str(SCRIPT.with_name("sync_compatibility.py")), "metadata", str(contract), str(output)],
                                capture_output=True, text=True, timeout=20)
        names = json.loads((contract / "composition.json").read_text())["registries"]
        self.assertEqual((result.returncode, result.stdout, result.stderr, names),
                         (0, "", "", ["gym.registry.json", "journal.registry.json", "roadmap.registry.json"]))
        # Roadmap joins additively: the composed version rises and the minimum a released gym or journal client meets
        # does not.
        self.assertEqual(json.loads(output.read_text()), {"schema": 13, "minSchema": 11})

    def test_the_server_takes_roadmap_s_switch_from_the_host_file_alone_which_no_deploy_renders_or_ships(self):
        root = SCRIPT.parents[2]
        compose = (root / "backend/deploy/docker-compose.yml").read_text()
        server = compose.split("\n  server:\n", 1)[1].split("\n  embedder:\n", 1)[0]
        self.assertIn("\n    env_file:\n      - roadmap-engine.env\n    environment:\n", server)
        self.assertEqual(compose.count("env_file:"), 1)
        self.assertNotRegex(compose, r"\n +ROADMAP_ENGINE_ENABLED:")
        workflow = (root / ".github/workflows/deploy.yml").read_text()
        for name in ("ROADMAP_ENGINE_ENABLED", "roadmap-engine.env"):
            self.assertNotIn(name, workflow)
        script = SCRIPT.read_text()
        self.assertEqual([line.strip() for line in script.splitlines() if "roadmap-engine.env" in line and not line.lstrip().startswith("#")],
                         ["[[ ! -e roadmap-engine.env ]] || roadmap_switch=$(cat roadmap-engine.env)",
                          "printf 'FAIL roadmap-engine.env holds something other than ROADMAP_ENGINE_ENABLED=1\\n' >&2",
                          "printf 'FAIL roadmap-engine.floor says roadmap is on the sync engine here, and roadmap-engine.env does not say "
                          "ROADMAP_ENGINE_ENABLED=1\\n' >&2",
                          "printf 'FAIL the database holds roadmap on the sync engine, and roadmap-engine.env does not say "
                          "ROADMAP_ENGINE_ENABLED=1\\n' >&2",
                          "[[ -e roadmap-engine.env ]] || : > roadmap-engine.env",
                          "roadmap = \"1\" if open(\"roadmap-engine.env\").read().strip() else \"\"",
                          "raise SystemExit(\"FAIL compose does not read roadmap-engine.env into the server\")",
                          "raise SystemExit(\"FAIL running server ROADMAP_ENGINE_ENABLED differs from roadmap-engine.env\")",
                          "printf 'PASS roadmap: the server runs with ROADMAP_ENGINE_ENABLED=1, kept from roadmap-engine.env\\n'"])
        if not shutil.which("docker") or subprocess.run(["docker", "compose", "version"], capture_output=True).returncode:
            self.skipTest("compose's reading of the file needs docker compose")
        work = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, work)
        shutil.copyfile(root / "backend/deploy/docker-compose.yml", work / "docker-compose.yml")
        (work / ".env").write_text("POSTGRES_PASSWORD=p\nDOMAIN_APP=app.localhost\nDOMAIN_API=api.localhost\nACME_EMAIL=ops@example.invalid\n"
                                   "ROADMAP_ENGINE_ENABLED=1\n")
        for switch, served in (("", None), ("ROADMAP_ENGINE_ENABLED=1\n", "1")):
            with self.subTest(switch=switch):
                (work / "roadmap-engine.env").write_text(switch)
                result = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=work, capture_output=True,
                                        text=True, timeout=60, check=True)
                self.assertEqual(json.loads(result.stdout)["services"]["server"]["environment"].get("ROADMAP_ENGINE_ENABLED"), served)

    def test_once_roadmap_is_on_the_engine_a_deploy_refuses_an_image_older_than_its_cutover_before_anything_reaches_the_host(self):
        text = (SCRIPT.parents[2] / ".github/workflows/deploy.yml").read_text()
        start = text.index("          # Roadmap on the sync engine runs only on the commit its cutover ran from")
        block = text[start:text.index("\n\n", start)]
        self.assertLess(start, text.index("$SSH \"$SSH_USER@$SSH_HOST\" 'mkdir -p ~/windmill"))
        self.assertGreater(start, text.index('SSH="ssh -i deploy_key -p ${PORT} -o StrictHostKeyChecking=accept-new"'))
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name) / "repository"
        root.mkdir()
        environment = {**os.environ, "GIT_AUTHOR_NAME": "Deploy test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
                       "GIT_COMMITTER_NAME": "Deploy test", "GIT_COMMITTER_EMAIL": "test@example.invalid"}
        def git(*arguments):
            return subprocess.run(["git", *arguments], cwd=root, env=environment, check=True, capture_output=True, text=True).stdout.strip()
        git("init", "-b", "main")
        commits = []
        for name in ("old", "cutover", "new"):
            git("commit", "--allow-empty", "-m", name)
            commits.append(git("rev-parse", "HEAD"))
        old, cutover, new = commits
        bin = Path(directory.name) / "bin"
        bin.mkdir()
        (bin / "ssh").write_text("#!/bin/sh\nprintf '%s' \"$FLOOR\"\n")
        (bin / "ssh").chmod(0o755)
        refused = (1, "Refusing deploy: roadmap is on the sync engine, and the selected image is older than the commit its cutover ran from.\n")
        for floor, image, outcome in (("", old, (0, "")), (cutover + "\n", cutover, (0, "")), (cutover + "\n", new, (0, "")),
                                      (cutover + "\n", old, refused), ("PRIVATE_DEPLOY_SECRET\n", new, refused),
                                      ("f" * 40 + "\n", new, refused)):
            with self.subTest(floor=floor, image=image):
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", 'SSH=ssh\n' + textwrap.dedent(block)], cwd=root,
                                        env={**environment, "PATH": str(bin) + os.pathsep + os.environ["PATH"], "FLOOR": floor,
                                             "IMAGE_TAG": image, "SSH_USER": "deploy", "SSH_HOST": "host"},
                                        capture_output=True, text=True)
                self.assertEqual((result.returncode, result.stdout + result.stderr), outcome)

    def test_the_deploy_lock_is_taken_under_the_condition_the_job_runs_under(self):
        text = (SCRIPT.parents[2] / ".github/workflows/deploy.yml").read_text()
        condition = lambda block: " ".join(block.split())
        job = condition(text.split("    if: >-\n", 1)[1].split("    runs-on:", 1)[0])
        lock = condition(text.split("  group: >-\n", 1)[1].split("  cancel-in-progress: false\n", 1)[0])
        self.assertEqual(lock, "${{ (" + job + ") && 'deploy-vps' || format('deploy-skipped-{0}', github.run_id) }}")
        backup = (SCRIPT.parents[2] / ".github/workflows/gym-backup.yml").read_text()
        self.assertIn("on:\n  workflow_dispatch:\n\npermissions:", backup)
        self.assertIn("group: deploy-vps\n  cancel-in-progress: false", backup)

    def test_workflow_requires_an_image_commit_reachable_from_main(self):
        workflow = SCRIPT.parents[2] / ".github/workflows/deploy.yml"
        text = workflow.read_text()
        start = text.index('          if [[ ! "$IMAGE_TAG"')
        end = text.index("          python3 - <<'PY'", start)
        guard = textwrap.dedent(text[start:end])
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name) / "repository"
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

    def test_the_render_names_the_commit_with_each_units_inputs_and_leaves_the_release_to_the_backends_commit(self):
        root = SCRIPT.parents[2]
        workflow = (root / ".github/workflows/deploy.yml").read_text()
        start = workflow.index("          : > rendered.env\n")
        end = workflow.index("          } >> rendered.env\n", start) + len("          } >> rendered.env\n")
        render = textwrap.dedent(workflow[start:end])
        keys = re.search(r"for key in (POSTGRES_PASSWORD[\s\S]*?); do", render).group(1).replace("\\", "").split()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        repository = Path(directory.name)
        environment = {**os.environ, "GIT_AUTHOR_NAME": "Deploy test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
                       "GIT_COMMITTER_NAME": "Deploy test", "GIT_COMMITTER_EMAIL": "test@example.invalid"}
        (repository / "backend/deploy").mkdir(parents=True)
        shutil.copyfile(SCRIPT.with_name("image_inputs.py"), repository / "backend/deploy/image_inputs.py")
        (repository / "services/ai").mkdir(parents=True)
        (repository / "services/ai/Dockerfile").write_text("FROM scratch\n")
        for arguments in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-qm", "commit"]):
            subprocess.run(["git", *arguments], cwd=repository, env=environment, check=True, capture_output=True)
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repository, check=True, capture_output=True,
                                text=True).stdout.strip()
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", render], cwd=repository, capture_output=True, text=True,
                                env={"PATH": os.environ["PATH"], "IMAGE_TAG": commit, **{key: "" for key in keys}})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))
        fingerprints = subprocess.run([sys.executable, str(SCRIPT.with_name("image_inputs.py")), commit], cwd=repository,
                                      check=True, capture_output=True, text=True).stdout.splitlines()
        rendered = (repository / "rendered.env").read_text().splitlines()
        self.assertEqual(rendered[:4], ["IMAGE_TAG=" + commit] + fingerprints)
        self.assertEqual([line.partition("=")[0] for line in fingerprints], ["BACKEND_INPUTS", "SUBSCRIPTIONS_INPUTS", "AI_INPUTS"])
        self.assertEqual([line for line in rendered if line.startswith(("SENTRY_RELEASE=", "BACKEND_TAG="))], [])
        compose = (root / "backend/deploy/docker-compose.yml").read_text()
        server = compose.split("\n  server:\n", 1)[1].split("\n  embedder:\n", 1)[0]
        self.assertIn("    image: ${SERVER_IMAGE:-ghcr.io/neigrok/windmill-monorepo:${BACKEND_TAG:-latest}}\n", server)
        self.assertIn("      SENTRY_RELEASE: ${BACKEND_TAG:-}\n", server)
        self.assertIn("\n    image: ghcr.io/neigrok/windmill-monorepo:embedder-${BACKEND_TAG:-latest}\n", compose)

    def test_a_units_fingerprint_moves_with_what_its_images_are_built_from_and_nothing_else(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        environment = {**os.environ, "GIT_AUTHOR_NAME": "Deploy test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
                       "GIT_COMMITTER_NAME": "Deploy test", "GIT_COMMITTER_EMAIL": "test@example.invalid"}
        def git(*arguments):
            return subprocess.run(["git", *arguments], cwd=root, env=environment, check=True,
                                  capture_output=True, text=True).stdout.strip()
        def fingerprints(commit):
            output = subprocess.run([sys.executable, str(SCRIPT.with_name("image_inputs.py")), commit], cwd=root,
                                    check=True, capture_output=True, text=True).stdout
            return dict(line.split("=", 1) for line in output.splitlines())
        def commit(change, message):
            change()
            git("add", "-A")
            git("commit", "-qm", message)
            return git("rev-parse", "HEAD")
        tracked = ("backend/platform/server.cpp", "backend/README.md", "backend/deploy/Caddyfile",
                   "backend/deploy/docker-compose.yml", "backend/deploy/ai-db/provision.sh",
                   "backend/deploy/sync_compatibility.py", "backend/test/deploy/ai_db_test.py",
                   "backend/test/platform/server_test.cpp", "services/embedder/server.js",
                   "services/subscriptions/src/main.rs", "services/subscriptions/ARCHITECTURE.md", "services/ai/src/main.rs",
                   "packages/api-contract/sync/gym.registry.json", "packages/api-contract/sync/corpus/case.json",
                   "packages/api-contract/sync/reference/core/merge.js", "packages/api-contract/gym/catalog.json",
                   "packages/api-contract/roadmap-socket.json", "packages/api-contract/subscriptions/feed.json",
                   "packages/api-contract/ai/wire/call.json", "packages/api-contract/domain-kit/vector.json",
                   "web/src/main.js", ".github/workflows/backend.yml", ".github/workflows/deploy.yml",
                   ".github/workflows/ai.yml")
        git("init", "-q", "-b", "main")
        for path in tracked:
            (root / path).parent.mkdir(parents=True, exist_ok=True)
            (root / path).write_text("first\n")
        base = commit(lambda: None, "base")
        before = fingerprints(base)
        self.assertEqual(list(before), ["BACKEND_INPUTS", "SUBSCRIPTIONS_INPUTS", "AI_INPUTS"])
        def moved(sha):
            after = fingerprints(sha)
            return {unit.removesuffix("_INPUTS") for unit in after if after[unit] != before[unit]}
        changes = [(path, lambda path=path: (root / path).write_text("second\n"), units) for path, units in (
            ("services/ai/src/main.rs", {"AI"}),
            ("services/subscriptions/src/main.rs", {"SUBSCRIPTIONS"}),
            ("backend/platform/server.cpp", {"BACKEND"}),
            ("backend/test/platform/server_test.cpp", {"BACKEND"}),
            ("backend/deploy/sync_compatibility.py", {"BACKEND"}),
            ("services/embedder/server.js", {"BACKEND"}),
            ("packages/api-contract/sync/gym.registry.json", {"BACKEND"}),
            ("packages/api-contract/sync/corpus/case.json", {"BACKEND"}),
            ("packages/api-contract/gym/catalog.json", {"BACKEND"}),
            ("packages/api-contract/roadmap-socket.json", {"BACKEND"}),
            ("packages/api-contract/subscriptions/feed.json", {"BACKEND"}),
            (".github/workflows/backend.yml", {"BACKEND", "SUBSCRIPTIONS", "AI"}),
            ("backend/README.md", set()), ("services/subscriptions/ARCHITECTURE.md", set()),
            ("backend/deploy/Caddyfile", set()), ("backend/deploy/docker-compose.yml", set()),
            ("backend/deploy/ai-db/provision.sh", set()), ("backend/test/deploy/ai_db_test.py", set()),
            ("packages/api-contract/sync/reference/core/merge.js", {"BACKEND"}),
            ("packages/api-contract/ai/wire/call.json", {"BACKEND"}), ("packages/api-contract/domain-kit/vector.json", {"BACKEND"}),
            ("web/src/main.js", set()),
            (".github/workflows/deploy.yml", set()), (".github/workflows/ai.yml", set()),
            ("services/ai/src/added.rs", {"AI"}))]
        changes += [
            ("a deleted backend file", lambda: (root / "backend/platform/server.cpp").unlink(), {"BACKEND"}),
            ("an executable bit", lambda: (root / "services/subscriptions/src/main.rs").chmod(0o755), {"SUBSCRIPTIONS"})]
        for name, change, units in changes:
            with self.subTest(name):
                git("checkout", "-q", base)
                self.assertEqual(moved(commit(change, name)), units)
        git("checkout", "-q", base)
        commit(lambda: (root / "services/ai/src/main.rs").write_text("second\n"), "change")
        self.assertEqual(moved(commit(lambda: (root / "services/ai/src/main.rs").write_text("first\n"), "revert")), set())
        git("checkout", "-q", base)
        git("checkout", "-qb", "service")
        commit(lambda: (root / "services/ai/src/main.rs").write_text("second\n"), "service")
        git("checkout", "-q", "main")
        commit(lambda: (root / "backend/platform/server.cpp").write_text("second\n"), "backend")
        git("merge", "-q", "--no-ff", "-m", "merge", "service")
        self.assertEqual(moved(git("rev-parse", "HEAD")), {"BACKEND", "AI"})

    def test_each_unit_counts_everything_its_images_are_built_from(self):
        root = SCRIPT.parents[2]
        specification = importlib.util.spec_from_file_location("image_inputs", SCRIPT.with_name("image_inputs.py"))
        inputs = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(inputs)
        build = (root / ".github/workflows/backend.yml").read_text().split("\n  build-and-push:\n", 1)[1]
        units = {"backend": "BACKEND_INPUTS", "services/embedder": "BACKEND_INPUTS",
                 "services/subscriptions": "SUBSCRIPTIONS_INPUTS", "services/ai": "AI_INPUTS"}
        self.assertEqual(re.findall(r"^          context: (\S+)$", build, re.M), list(units))
        self.assertEqual(re.findall(r"^          build-contexts: (\S+)$", build, re.M), ["contract=packages/api-contract"])
        for context, unit in units.items():
            with self.subTest(context=context):
                listed = subprocess.run(["git", "ls-files", "-z", "--", context], cwd=root, check=True,
                                        capture_output=True, text=True).stdout.split("\0")
                self.assertTrue(inputs.counts(inputs.UNITS[unit], ".github/workflows/backend.yml"))
                self.assertTrue(inputs.counts(inputs.UNITS[unit], context + "/Dockerfile"))
                self.assertEqual([path for path in listed if path and not path.endswith(".md")
                                  and not inputs.counts(inputs.UNITS[unit], path)
                                  and not path.startswith(("backend/deploy/", "backend/test/deploy/"))], [])
        dockerfile = (root / "backend/Dockerfile").read_text()
        instructions = "\n".join(line for line in dockerfile.splitlines() if not line.lstrip().startswith("#"))
        self.assertEqual(set(re.findall(r"\S*deploy/\S*", instructions)), {"deploy/sync_compatibility.py"})
        contract = root / "packages/api-contract"
        sources = [source for line in re.findall(r"^COPY --from=contract (.+)$", instructions, re.M)
                   for source in line.split()[:-1]]
        copied = [found for source in sources for match in ([contract] if source == "/" else contract.glob(source))
                  for found in ([match] if match.is_file() else match.rglob("*")) if found.is_file()]
        self.assertGreater(len(copied), len(sources))
        self.assertEqual([str(path.relative_to(root)) for path in copied if not path.name.endswith(".md")
                          and not inputs.counts(inputs.UNITS["BACKEND_INPUTS"], str(path.relative_to(root)))], [])

    def test_the_subscription_password_renders_only_as_hex_and_is_never_repeated(self):
        text = (SCRIPT.parents[2] / ".github/workflows/deploy.yml").read_text()
        start = text.index("          missing=\n")
        guard = textwrap.dedent(text[start:text.index('          if [ "$AI_INSTALLATIONS_ENABLED"', start)])
        unset = ("Refusing to render — these required values are unset: SUBSCRIPTIONS_DB_PASSWORD\n"
                 "Set them (variables for the domains/email/sender, the database passwords and AI service secrets) and re-run.\n"
                 "(CF_IPS is not configured anywhere — if it is listed, both the live fetch and the compose fallback came"
                 " back empty.)\n")
        malformed = "Refusing to render — SUBSCRIPTIONS_DB_PASSWORD must be 64 lowercase hex characters (openssl rand -hex 32).\n"
        required = {key: "configured" for key in ("DOMAIN_APP", "DOMAIN_API", "ACME_EMAIL", "POSTGRES_PASSWORD",
                                                  "RESEND_FROM", "CF_IPS")}
        required.update({"AI_DB_PASSWORD": "c" * 64, "AI_PASS_KEYS": "{}", "AI_CARRY_KEY": "A" * 43,
                         "AI_FUNDING_SECRET": "f" * 32, "AI_OPERATOR_SECRET": "o" * 32})
        for value, outcome in (("", (1, unset)), ("0123456789abcdef" * 4, (0, "")), ("A" * 64, (1, malformed)),
                               ("a" * 63, (1, malformed)), ("a" * 64 + "\n", (1, malformed)),
                               ("private canary@host/db", (1, malformed))):
            with self.subTest(length=len(value)):
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", guard], capture_output=True, text=True,
                                        env={**os.environ, **required, "SUBSCRIPTIONS_DB_PASSWORD": value,
                                             "SUBSCRIPTIONS_INTERNAL_TOKEN": ""})
                self.assertEqual((result.returncode, result.stdout + result.stderr), outcome)

    def test_the_internal_token_renders_only_empty_or_as_hex_and_is_never_repeated(self):
        text = (SCRIPT.parents[2] / ".github/workflows/deploy.yml").read_text()
        start = text.index("          missing=\n")
        guard = textwrap.dedent(text[start:text.index('          if [ "$AI_INSTALLATIONS_ENABLED"', start)])
        malformed = ("Refusing to render — SUBSCRIPTIONS_INTERNAL_TOKEN must be empty or 64 lowercase hex characters"
                     " (openssl rand -hex 32).\n")
        required = {key: "configured" for key in ("DOMAIN_APP", "DOMAIN_API", "ACME_EMAIL", "POSTGRES_PASSWORD",
                                                  "RESEND_FROM", "CF_IPS")}
        required.update({"AI_DB_PASSWORD": "c" * 64, "AI_PASS_KEYS": "{}", "AI_CARRY_KEY": "A" * 43,
                         "AI_FUNDING_SECRET": "f" * 32, "AI_OPERATOR_SECRET": "o" * 32})
        for value, outcome in (("", (0, "")), ("0123456789abcdef" * 4, (0, "")), ("A" * 64, (1, malformed)),
                               ("a" * 63, (1, malformed)), ("a" * 64 + "\n", (1, malformed)),
                               ("${PRIVATE_CANARY}" + "a" * 47, (1, malformed))):
            with self.subTest(length=len(value)):
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", guard], capture_output=True, text=True,
                                        env={**os.environ, **required, "SUBSCRIPTIONS_DB_PASSWORD": "f" * 64,
                                             "SUBSCRIPTIONS_INTERNAL_TOKEN": value})
                self.assertEqual((result.returncode, result.stdout + result.stderr), outcome)

    def test_windmill_one_settings_render_from_variables_to_the_server_and_default_to_closed(self):
        root = SCRIPT.parents[2]
        workflow = (root / ".github/workflows/deploy.yml").read_text()
        compose = (root / "backend/deploy/docker-compose.yml").read_text()
        server = compose.split("\n  server:\n", 1)[1].split("\n  embedder:\n", 1)[0]
        render = re.search(r"for key in POSTGRES_PASSWORD[\s\S]*?\n\s*done", workflow).group()
        rendered = lambda environment: subprocess.run(["bash", "-euc", render], env=environment, check=True,
                                                      capture_output=True, text=True).stdout.splitlines()
        settings = ("WINDMILL_SANDBOX_EMAILS", "SUBSCRIPTIONS_PURCHASABLE_STORES")
        keys = render.partition("; do")[0].replace("\\", "").split()[3:]
        unset = {key: "" for key in keys if key not in settings}
        for name in settings:
            with self.subTest(name=name):
                self.assertIn(f"          {name}: ${{{{ vars.{name} }}}}\n", workflow)
                self.assertNotIn(f"secrets.{name}", workflow)
                self.assertIn(f"      {name}: ${{{name}:-}}\n", server)
                self.assertIn(f"{name}=", rendered({**unset, **{other: "" for other in settings}}))
                self.assertIn(f"{name}=configured", rendered({**unset, **{other: "configured" for other in settings}}))

    def test_the_open_stores_render_only_as_names_the_server_knows(self):
        text = (SCRIPT.parents[2] / ".github/workflows/deploy.yml").read_text()
        start = text.index("          stores=")
        guard = textwrap.dedent(text[start:text.index("          # printf so values are written literally", start)])
        refused = (1, "Refusing to render — SUBSCRIPTIONS_PURCHASABLE_STORES must list app_store, play_store or paddle,"
                      " comma-separated.\n")
        for value, outcome in (("", (0, "")), ("app_store", (0, "")), (" app_store , paddle", (0, "")),
                               ("play_store,paddle,app_store,", (0, "")), ("appstore", refused), ("App_Store", refused),
                               ("app_store;paddle", refused), ("app_store,,paddle", refused),
                               ("app_store,google_play", refused)):
            with self.subTest(value=value):
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", guard], capture_output=True, text=True,
                                        env={**os.environ, "SUBSCRIPTIONS_PURCHASABLE_STORES": value})
                self.assertEqual((result.returncode, result.stdout + result.stderr), outcome)
        unset = subprocess.run(["bash", "-euo", "pipefail", "-c", guard], capture_output=True, text=True,
                               env={key: value for key, value in os.environ.items()
                                    if key != "SUBSCRIPTIONS_PURCHASABLE_STORES"})
        self.assertEqual((unset.returncode, unset.stdout + unset.stderr), (0, ""))

    def test_backend_readiness_probes_admit_the_current_schema_without_pinning_an_old_client(self):
        root = SCRIPT.parents[2]
        workflow = (root / ".github/workflows/backend.yml").read_text()
        probes = [line for line in workflow.splitlines() if "curl " in line and "/v1/sync/hello" in line]
        self.assertEqual(len(probes), 4)
        versions = [int(re.search(r"Sync-Schema: (\d+)", line).group(1)) for line in probes]
        registries = [json.loads(path.read_text()) for path in (root / "packages/api-contract/sync").glob("*.registry.json")]
        minimum = max(registry["minVersion"] for registry in registries)
        self.assertTrue(all(version >= minimum for version in versions), (versions, minimum))

    def test_backend_image_context_contains_the_sync_metadata_helper(self):
        backend = SCRIPT.parents[1]
        rules = (backend / ".dockerignore").read_text().splitlines()
        exclusion = rules.index("deploy/*")
        inclusion = rules.index("!deploy/sync_compatibility.py")
        self.assertGreater(inclusion, exclusion)
        self.assertTrue(SCRIPT.with_name("sync_compatibility.py").is_file())
        self.assertIn("RUN python3 deploy/sync_compatibility.py metadata /contract/sync build/sync-compatibility.json",
                      (backend / "Dockerfile").read_text())


if __name__ == "__main__":
    if sys.argv[1:2] == ["--web-shim"]:
        sys.exit(web_shim(sys.argv[2], sys.argv[3:]))
    if sys.argv[1:2] == ["--docker-shim"]:
        sys.exit(docker_shim(sys.argv[2:]))
    unittest.main()
