import json
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest

from coach_provider_ci import VerificationFailure
from coach_provider_deployed import DeployedCoachRun
import test_coach_provider_ci as ci_tests


class DeployedCoachTest(unittest.TestCase):
    def setUp(self):
        self.private = tempfile.TemporaryDirectory()
        self.addCleanup(self.private.cleanup)
        self.environment = {
            "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_EVENT_NAME": "workflow_dispatch",
            "COACH_VERIFY_DEPLOYED": "true", "GITHUB_REPOSITORY": "neigrok/windmill-monorepo",
            "EXPECTED_IMAGE_SHA": "a" * 40, "GITHUB_SHA": "b" * 40,
            "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_WORKSPACE": self.private.name, "RUNNER_TEMP": self.private.name,
            "SSH_HOST": "private-host.invalid", "SSH_USER": "deploy", "SSH_PORT": "22", "SSH_KEY": "PRIVATE-TEST-KEY",
            "ANTHROPIC_API_KEY": "UNRELATED-PROVIDER-SECRET", "DATABASE_URL": "UNRELATED-DATABASE-SECRET",
            "PATH": "/usr/bin", "HOME": self.private.name,
        }
        self.commands = []
        self.requests = []
        self.harness_exit = 0
        self.image_mismatch = False
        self.image_changed = False
        self.image_reads = 0
        self.usage_missing = False
        self.seed_collision = False
        self.owned = True
        self.active = False
        self.stuck = False
        self.remove_refused = False
        self.state_reads = 0
        self.harness_calls = 0
        self.run = DeployedCoachRun(self.environment, self.execute, self.connection, lambda seconds: None)

    def connection(self, host, timeout):
        self.assertEqual((host, timeout), ("windmill.works", 10))
        outer = self

        class Connection:
            def request(self, method, path, body, headers):
                outer.requests.append((method, path))
                outer.assertEqual(method, "POST")
                outer.assertEqual(headers, {"Authorization": "Bearer " + outer.run.token})
                if not outer.stuck:
                    outer.active = False

            def getresponse(self):
                return SimpleNamespace(status=200, read=lambda count: b"{}")

            def close(self):
                pass

        return Connection()

    def execute(self, arguments, **options):
        self.commands.append((arguments, options))
        output = ""
        code = 0
        if arguments[0] == "git":
            output = self.environment["GITHUB_SHA"]
        elif arguments[0] == "docker":
            self.assertEqual(arguments, ["docker", "--host", "unix:///var/run/docker.sock", "buildx", "imagetools",
                                        "inspect", "--format", "{{json .Manifest}}", self.run.image])
            output = json.dumps({"digest": "sha256:" + "c" * 64})
        elif arguments[0] == "ssh":
            self.assertEqual(Path(arguments[arguments.index("-i") + 1]).stat().st_mode & 0o777, 0o600)
            self.assertEqual(options["env"], {"PATH": "/usr/bin", "HOME": self.private.name})
            script = options["input"]
            if "docker inspect" in script:
                self.image_reads += 1
                image_id = "sha256:" + ("e" if self.image_changed and self.image_reads == 2 else "d") * 64
                output = json.dumps({"image": "wrong-image" if self.image_mismatch else self.run.image,
                                     "imageId": image_id, "running": True, "health": "healthy"}) + "\n"
                output += json.dumps({"id": image_id, "repoDigests": [self.run.repository + "@sha256:" + "c" * 64]})
            elif "INSERT INTO users" in script:
                self.assertIn("BEGIN;", script)
                self.assertIn("COMMIT;", script)
                self.assertNotIn("ON CONFLICT", script)
                self.assertNotIn(self.run.token, script)
                output = self.run.account
                code = 1 if self.seed_collision else 0
            elif "'owned'" in script:
                self.state_reads += 1
                active = [{"thread": "thr_12345678", "requestId": "req_12345678"}] if self.active else []
                output = json.dumps({"owned": self.owned, "generations": 3 if self.owned else 0,
                                     "active": active if self.owned else []})
                self.assertIn(self.run.owner_clause(), script)
            elif "FROM ai_usage" in script:
                output = json.dumps([{"runId": "ask-synthetic-" + str(index), "model": "claude-opus-5", "outcome": "ok",
                                      "iteration": 0, "inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 0,
                                      "cacheWriteTokens": 30, "costNanos": 500, "costFloorNanos": 500} for index in range(3)])
                if self.usage_missing:
                    output = "[]"
                self.assertIn(self.run.owner_clause(), script)
            elif "DELETE FROM users" in script:
                self.assertIn("DELETE FROM users WHERE " + self.run.owner_clause(), script)
                self.assertIn("pg_try_advisory_xact_lock(hashtextextended('gym-ask:' || row.id,0))", script)
                self.assertIn("payload->>'status'='running'", script)
                self.assertIn("token_hash<>'" + self.run.digest, script)
                code = 1 if self.remove_refused else 0
                output = "removed"
            elif "DELETE FROM sessions" in script:
                self.assertIn("WHERE user_id='" + self.run.account + "'::uuid AND token_hash='" + self.run.digest + "'", script)
                output = "revoked"
            else:
                self.fail("Unexpected remote operation")
        else:
            self.harness_calls += 1
            self.assertTrue(arguments[1].endswith("coach_provider_acceptance.py"))
            self.assertIn("--allow-remote", arguments)
            self.assertEqual(arguments[arguments.index("--base-url") + 1], "https://windmill.works")
            self.assertEqual(options["timeout"], 600)
            self.assertEqual(options["env"], {"PATH": "/usr/bin", "HOME": self.private.name,
                "COACH_TEST_CANDIDATE_SHA": "a" * 40, "COACH_TEST_PROVIDER_MARKER": "anthropic-production-configured"})
            credential = Path(arguments[arguments.index("--session-file") + 1])
            self.assertEqual(credential.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(credential.read_text()), {"token": self.run.token, "accountId": self.run.account,
                              "email": self.run.email, "syntheticAccount": True})
            output = "PRIVATE-TEST-KEY " + self.run.token
            code = self.harness_exit
        return SimpleNamespace(returncode=code, stdout=output, stderr="private-host.invalid PRIVATE-TEST-KEY")

    def sql_commands(self):
        return [options["input"] for args, options in self.commands if args[0] == "ssh" and "psql" in options["input"]]

    def test_success_checks_image_twice_and_removes_only_created_quiescent_fixture(self):
        self.assertEqual(self.run.run(), 0)
        self.assertEqual(self.run.report["before"], self.run.report["after"])
        self.assertEqual(self.run.report["before"], {"image": self.run.image, "imageId": "sha256:" + "d" * 64,
                                                    "registryDigest": "sha256:" + "c" * 64, "health": "healthy"})
        self.assertEqual(self.run.report["cleanup"], {"accountRemoved": True, "sessionRevoked": True, "remainingFixture": False})
        self.assertEqual(self.run.report["fixture"]["created"], True)
        self.assertEqual(self.harness_calls, 1)
        evidence = (self.run.evidence / "coach-provider-deployed.json").read_text()
        for secret in ("PRIVATE-TEST-KEY", "private-host.invalid", "UNRELATED-PROVIDER-SECRET", "UNRELATED-DATABASE-SECRET", self.run.token, self.run.digest):
            self.assertNotIn(secret, evidence)
        self.assertFalse(any("DELETE FROM ai_usage" in sql for sql in self.sql_commands()))
        self.assertEqual(list(Path(self.private.name).glob("coach-deployed-private-*")), [])
        for args, options in self.commands:
            self.assertNotIn("ANTHROPIC_API_KEY", options["env"])
            self.assertNotIn("SSH_KEY", options["env"])
            self.assertNotIn(self.run.token, " ".join(args))

    def test_expected_image_mismatch_produces_zero_data_writes(self):
        self.image_mismatch = True
        self.assertEqual(self.run.run(), 1)
        self.assertEqual(self.sql_commands(), [])
        self.assertEqual(self.harness_calls, 0)
        self.assertEqual(self.run.report["stage"], "deployed_image_mismatch")

    def test_seed_collision_never_runs_harness_or_deletes_an_account(self):
        self.seed_collision = True
        self.assertEqual(self.run.run(), 1)
        self.assertFalse(self.run.report["fixture"]["created"])
        self.assertEqual(self.harness_calls, 0)
        self.assertFalse(any("DELETE FROM users" in sql for sql in self.sql_commands()))
        self.assertTrue(self.run.report["cleanup"]["sessionRevoked"])

    def test_image_change_fails_acceptance_and_still_removes_owned_quiescent_fixture(self):
        self.image_changed = True
        self.assertEqual(self.run.run(), 1)
        self.assertEqual(self.run.report["stage"], "deployed_image_changed")
        self.assertTrue(self.run.report["cleanup"]["accountRemoved"])
        self.assertEqual(self.harness_calls, 1)

    def test_missing_usage_cannot_pass_but_does_not_prevent_safe_fixture_cleanup(self):
        self.usage_missing = True
        self.assertEqual(self.run.run(), 1)
        self.assertEqual(self.run.report["stage"], "provider_usage_missing")
        self.assertTrue(self.run.report["cleanup"]["accountRemoved"])

    def test_changed_owner_marker_only_revokes_the_new_session(self):
        self.owned = False
        self.assertEqual(self.run.run(), 1)
        self.assertFalse(any("DELETE FROM users" in sql or "FROM ai_usage" in sql for sql in self.sql_commands()))
        self.assertEqual(self.requests, [])
        self.assertEqual(self.run.report["cleanup"], {"accountRemoved": False, "sessionRevoked": True, "remainingFixture": True})

    def test_active_generation_is_stopped_before_transactional_lease_guarded_cleanup(self):
        self.active = True
        self.assertEqual(self.run.run(), 0)
        self.assertEqual(self.requests, [("POST", "/v1/gym/threads/thr_12345678/generations/req_12345678/stop")])
        self.assertTrue(self.run.report["cleanup"]["accountRemoved"])

    def test_unfinished_generation_has_bounded_stop_poll_and_retains_fixture(self):
        self.active = self.stuck = True
        self.assertEqual(self.run.run(), 1)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.state_reads, 13)
        self.assertFalse(any("DELETE FROM users" in sql for sql in self.sql_commands()))
        self.assertEqual(self.run.report["cleanup"], {"accountRemoved": False, "sessionRevoked": True, "remainingFixture": True})

    def test_transactional_cleanup_refusal_preserves_fixture_and_revokes_session(self):
        self.remove_refused = True
        self.assertEqual(self.run.run(), 1)
        self.assertEqual(self.run.report["cleanup"], {"accountRemoved": False, "sessionRevoked": True, "remainingFixture": True})

    def test_timing_inconclusive_remains_distinct_from_product_failure(self):
        self.harness_exit = 3
        self.assertEqual(self.run.run(), 3)
        self.assertEqual((self.run.report["status"], self.run.report["stage"]), ("inconclusive", "acceptance_inconclusive"))
        self.assertTrue(self.run.report["cleanup"]["accountRemoved"])

    def test_mode_and_full_expected_sha_are_required_before_any_operation(self):
        for key, value in (("EXPECTED_IMAGE_SHA", "latest"), ("COACH_VERIFY_DEPLOYED", "false"),
                           ("GITHUB_EVENT_NAME", "workflow_run"), ("RUNNER_ENVIRONMENT", "self-hosted"),
                           ("SSH_HOST", "-oProxyCommand=bad")):
            with self.subTest(key=key), self.assertRaises(VerificationFailure):
                DeployedCoachRun(dict(self.environment, **{key: value}), self.execute)
        self.assertEqual(self.commands, [])


class DeployedCoachWorkflowTest(unittest.TestCase):
    def test_deployed_smoke_mode_skips_deploy_and_scopes_ssh_secrets_and_artifacts(self):
        helper = ci_tests.CoachProviderWorkflowTest()
        root = Path(__file__).resolve().parents[3]
        source = (root / ".github/workflows/deploy.yml").read_text()
        deploy = helper.condition(helper.job(source, "deploy"))
        smoke = helper.condition(helper.job(source, "verify-deployed-coach"))
        for event, mode, branch, triggered_event, expected in (
                ("workflow_dispatch", True, "main", "push", (False, True)),
                ("workflow_dispatch", False, "main", "push", (True, False)),
                ("workflow_run", False, "main", "push", (True, False)),
                ("workflow_run", False, "codex/gym-feedback", "push", (False, False)),
                ("workflow_run", False, "main", "workflow_dispatch", (False, False))):
            values = {"github.event_name": event, "inputs.verify_coach_only": mode,
                      "github.event.workflow_run.conclusion": "success",
                      "github.event.workflow_run.head_branch": branch,
                      "github.event.workflow_run.event": triggered_event}
            self.assertEqual((helper.evaluate(deploy, values), helper.evaluate(smoke, values)), expected)
        job = helper.job(source, "verify-deployed-coach")
        self.assertIn("contents: read", job)
        self.assertIn("EXPECTED_IMAGE_SHA: ${{ inputs.image_tag }}", job)
        self.assertEqual(re.findall(r"secrets\.([A-Z_]+)", job), ["SSH_KEY", "SSH_HOST", "SSH_USER", "SSH_PORT"])
        self.assertEqual(re.findall(r"\$\{\{ runner.temp \}\}/([^\n]+)", job), [
            "coach-deployed-evidence/coach-provider-deployed.json", "coach-deployed-evidence/coach-provider-acceptance.json"])
        self.assertRegex(source, r"concurrency:\n  group: deploy-vps\n  cancel-in-progress: false")
        self.assertRegex(source, r"verify_coach_only:\n(?:[^\n]*\n){2}        default: false")
        self.assertNotIn("docker/login-action", job)
        self.assertNotIn("build-push-action", job)


if __name__ == "__main__":
    unittest.main()
