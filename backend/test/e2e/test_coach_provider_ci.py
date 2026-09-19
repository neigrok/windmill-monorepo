import ast
import json
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest

from coach_provider_ci import CoachProviderRun, VerificationFailure


class CoachProviderBootstrapTest(unittest.TestCase):
    def setUp(self):
        self.private = tempfile.TemporaryDirectory()
        self.addCleanup(self.private.cleanup)
        root = Path(self.private.name)
        (root / "backend/db").mkdir(parents=True)
        (root / "backend/db/schema.sql").write_text("SELECT 'schema';")
        self.environment = {
            "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "COACH_VERIFY_PROVIDER": "true",
            "GITHUB_SHA": "b" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2",
            "GITHUB_REPOSITORY": "neigrok/windmill-monorepo",
            "GITHUB_WORKSPACE": str(root), "RUNNER_TEMP": str(root),
            "ANTHROPIC_API_KEY": "test-provider-secret-never-output", "PATH": "/usr/bin", "HOME": str(root),
            "SSH_KEY": "unrelated-secret", "DATABASE_URL": "postgresql://production.invalid/private",
            "DOCKER_HOST": "tcp://untrusted.invalid:2375", "COACH_ANTHROPIC_BASE_URL": "https://untrusted.invalid",
        }
        self.commands = []
        self.fail_command = None
        self.harness_exit = 0
        self.logs = ""
        self.usage = {"generations": 3, "routines": 1, "usage": [{
            "runId": "synthetic-provider-run", "model": "claude-opus-5", "outcome": "ok", "iteration": 0,
            "inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 50, "cacheWriteTokens": 10,
            "costNanos": 500, "costFloorNanos": 500,
        }]}

    def execute(self, arguments, **options):
        self.commands.append((arguments, options))
        text = ""
        if arguments[0] == "git":
            text = self.environment["GITHUB_SHA"] + "\n"
        elif arguments[0] == "docker":
            self.assertEqual(arguments[1:3], ["--host", "unix:///var/run/docker.sock"])
            command = arguments[3:]
            if self.fail_command and command[:len(self.fail_command)] == self.fail_command:
                return SimpleNamespace(returncode=1, stdout="private data", stderr=self.environment["ANTHROPIC_API_KEY"])
            if command[:2] == ["image", "inspect"]:
                text = "sha256:" + "d" * 64 + "|" + self.environment["GITHUB_SHA"] + "\n"
            elif command[:2] == ["network", "create"]:
                text = "a" * 64 + "\n"
            elif command[0] == "create":
                text = ("2" if "--publish" in command else "1") * 64 + "\n"
            elif command[0] == "port":
                text = "127.0.0.1:18188\n"
            elif command[0] == "logs":
                self.assertEqual(command, ["logs", "--tail", "500", "2" * 64])
                text = self.logs
            elif command[0] == "exec" and "json_build_object" in (options.get("input") or ""):
                text = json.dumps(self.usage)
        else:
            self.assertTrue(arguments[1].endswith("coach_provider_acceptance.py"))
            self.assertEqual(options["timeout"], 600)
            session_path = Path(arguments[arguments.index("--session-file") + 1])
            session = json.loads(session_path.read_text())
            self.assertEqual(set(session), {"token", "accountId", "email", "syntheticAccount"})
            self.assertEqual(session_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(session["email"], "coach-provider-ci@example.invalid")
            self.assertEqual(session["syntheticAccount"], True)
            self.assertEqual(len(session["token"]), 64)
            self.assertEqual(options["env"], {
                "PATH": "/usr/bin", "HOME": self.private.name,
                "COACH_TEST_CANDIDATE_SHA": "b" * 40,
                "COACH_TEST_PROVIDER_MARKER": "anthropic-production-configured",
            })
            text = self.environment["ANTHROPIC_API_KEY"] + " private transport data"
            return SimpleNamespace(returncode=self.harness_exit, stdout=text, stderr="")
        return SimpleNamespace(returncode=0, stdout=text, stderr="")

    def test_complete_run_owns_isolated_resources_and_passes_key_only_to_candidate_environment(self):
        run = CoachProviderRun(self.environment, self.execute)
        self.assertEqual(run.run(), 0)
        report = json.loads((run.evidence / "coach-provider-run.json").read_text())
        self.assertEqual(report, {
            "sourceSha": "b" * 40, "githubRunId": "123", "githubRunAttempt": "2",
            "githubRunUrl": "https://github.com/neigrok/windmill-monorepo/actions/runs/123",
            "provider": "anthropic", "providerBaseUrl": "https://api.anthropic.com",
            "expectedModel": "claude-opus-5", "syntheticDataOnly": True, "maxNewRequests": 3,
            "status": "passed", "stage": "complete", "imageId": "sha256:" + "d" * 64,
            "resourcesRemoved": True, "modelRuns": 1, **self.usage,
            "streamDiagnostics": [],
        })
        with_key = [(args, options) for args, options in self.commands if "ANTHROPIC_API_KEY" in options["env"]]
        self.assertEqual(len(with_key), 1)
        candidate, options = with_key[0]
        self.assertIn("COACH_ANTHROPIC_BASE_URL=https://api.anthropic.com", candidate)
        self.assertIn("DATABASE_URL=postgresql://coach_verify@db:5432/coach_verify", candidate)
        self.assertIn("127.0.0.1::8080", candidate)
        self.assertEqual(candidate[-1], "windmill-coach-verify:" + "b" * 40)
        self.assertEqual(options["env"], {"PATH": "/usr/bin", "HOME": self.private.name,
                                           "ANTHROPIC_API_KEY": "test-provider-secret-never-output"})
        for arguments, options in self.commands:
            self.assertNotIn("test-provider-secret-never-output", " ".join(arguments))
            self.assertNotIn("SSH_KEY", options["env"])
            self.assertNotIn("production.invalid", " ".join(arguments))
            self.assertNotIn("untrusted.invalid", " ".join(arguments))
        cleanup = [args[3:] for args, _ in self.commands if args[0] == "docker" and args[3] in ("rm", "network")][-3:]
        self.assertEqual(cleanup, [["rm", "--force", "2" * 64], ["rm", "--force", "1" * 64], ["network", "rm", "a" * 64]])
        self.assertEqual(list(Path(self.private.name).glob("coach-provider-private-*")), [])
        self.assertNotIn("private data", json.dumps(report))

    def test_start_failure_cleans_only_created_ids_and_does_not_expose_command_output(self):
        self.fail_command = ["start", "2" * 64]
        run = CoachProviderRun(self.environment, self.execute)
        self.assertEqual(run.run(), 1)
        self.assertEqual(run.report["stage"], "candidate_start")
        self.assertEqual(run.report["resourcesRemoved"], True)
        report = (run.evidence / "coach-provider-run.json").read_text()
        self.assertNotIn(self.environment["ANTHROPIC_API_KEY"], report)
        self.assertNotIn("private data", report)
        self.assertEqual(list(Path(self.private.name).glob("coach-provider-private-*")), [])

    def test_no_provider_key_fails_before_any_docker_resource_is_created(self):
        self.environment.pop("ANTHROPIC_API_KEY")
        run = CoachProviderRun(self.environment, self.execute)
        self.assertEqual(run.run(), 1)
        self.assertEqual(run.report["stage"], "provider_key_not_configured")
        self.assertEqual(self.commands, [])

    def test_bootstrap_requires_explicit_hosted_manual_mode(self):
        for key, value in (("GITHUB_EVENT_NAME", "push"), ("COACH_VERIFY_PROVIDER", "false"),
                           ("RUNNER_ENVIRONMENT", "self-hosted"), ("GITHUB_ACTIONS", "false"),
                           ("GITHUB_SHA", "latest"), ("GITHUB_REPOSITORY", "other/repository")):
            with self.subTest(key=key):
                environment = dict(self.environment, **{key: value})
                with self.assertRaises(VerificationFailure):
                    CoachProviderRun(environment, self.execute)
        self.assertEqual(self.commands, [])

    def test_excess_requests_and_unexpected_usage_cannot_be_reported_as_acceptance(self):
        run = CoachProviderRun(self.environment, self.execute)
        self.usage["generations"] = 4
        self.assertEqual(run.run(), 1)
        self.assertEqual(run.report["stage"], "usage_validation")
        self.assertEqual(run.report["resourcesRemoved"], True)

    def test_completed_replay_cannot_hide_an_extra_provider_run_in_usage(self):
        run = CoachProviderRun(self.environment, self.execute)
        self.usage["generations"] = 1
        self.usage["usage"].append(dict(self.usage["usage"][0], runId="unexpected-replay-run"))
        self.assertEqual(run.run(), 1)
        self.assertEqual(run.report["modelRuns"], 2)
        self.assertEqual(run.report["stage"], "usage_validation")
        self.assertEqual(run.report["resourcesRemoved"], True)

    def test_missing_timing_proof_remains_inconclusive_after_cleanup(self):
        self.harness_exit = 3
        run = CoachProviderRun(self.environment, self.execute)
        self.assertEqual(run.run(), 3)
        self.assertEqual(run.report["status"], "inconclusive")
        self.assertEqual(run.report["stage"], "acceptance_inconclusive")
        self.assertEqual(run.report["resourcesRemoved"], True)

    def test_diagnostics_retain_only_allowlisted_fields_and_discard_all_other_logs(self):
        diagnostic = {"httpStatus": 200, "curlCode": 23, "messageStarted": False, "messageComplete": False,
                      "cancelled": False, "callbackFailed": False,
                      "parserFailure": "provider_error", "providerError": "overloaded_error"}
        private = self.environment["ANTHROPIC_API_KEY"] + " PRIVATE prompt response thinking header"
        self.logs = (private + "\n2026 INFO anthropic_stream_diagnostic=" + json.dumps(diagnostic)
                     + " - AnthropicStream.cpp:200\n" + private)
        run = CoachProviderRun(self.environment, self.execute)
        self.assertEqual(run.run(), 0)
        self.assertEqual(run.report["streamDiagnostics"], [diagnostic])
        evidence = (run.evidence / "coach-provider-run.json").read_text()
        for value in (private, "PRIVATE", "AnthropicStream.cpp", "2026 INFO"):
            self.assertNotIn(value, evidence)
        commands = [args[3:] for args, _ in self.commands if args[0] == "docker"]
        self.assertLess(commands.index(["stop", "--time", "5", "2" * 64]), commands.index(["logs", "--tail", "500", "2" * 64]))
        self.assertLess(commands.index(["logs", "--tail", "500", "2" * 64]), commands.index(["rm", "--force", "2" * 64]))

    def test_private_unknown_or_excess_diagnostics_fail_closed_and_resources_are_removed(self):
        diagnostic = {"httpStatus": 429, "curlCode": 0, "messageStarted": False, "messageComplete": False,
                      "cancelled": False, "callbackFailed": False,
                      "parserFailure": "missing_message_start", "providerError": "rate_limit_error"}
        for suffix, row, count in (
                ("extra_field", dict(diagnostic, body="PRIVATE body"), 1),
                ("unknown_type", dict(diagnostic, providerError="PRIVATE error type"), 1),
                ("wrong_number", dict(diagnostic, curlCode=True), 1),
                ("too_many", diagnostic, 25)):
            with self.subTest(case=suffix):
                self.logs = ("anthropic_stream_diagnostic=" + json.dumps(row) + "\n") * count
                run = CoachProviderRun(self.environment, self.execute)
                run.evidence = Path(self.private.name) / suffix
                self.assertEqual(run.run(), 1)
                self.assertEqual(run.report["stage"], "stream_diagnostics_validation")
                self.assertEqual(run.report["streamDiagnostics"], [])
                self.assertTrue(run.report["resourcesRemoved"])
                self.assertNotIn("PRIVATE", (run.evidence / "coach-provider-run.json").read_text())


class CoachProviderWorkflowTest(unittest.TestCase):
    def job(self, source, name):
        match = re.search(r"^  " + re.escape(name) + r":\n(.*?)(?=^  [a-zA-Z]|\Z)", source, re.MULTILINE | re.DOTALL)
        self.assertIsNotNone(match)
        return match.group(1)

    def condition(self, job):
        match = re.search(r"^    if: (.*?)(?=\n    [a-zA-Z]|\Z)", job, re.MULTILINE | re.DOTALL)
        self.assertIsNotNone(match)
        return " ".join(match.group(1).replace(">-", "").split())

    def evaluate(self, expression, values):
        for name, value in sorted(values.items(), key=lambda item: -len(item[0])):
            expression = expression.replace(name, repr(value))
        expression = re.sub(r"!(?!=)", "not ", expression).replace("&&", " and ").replace("||", " or ")
        tree = ast.parse(expression, mode="eval")
        allowed = (ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.Compare, ast.Eq, ast.NotEq, ast.UnaryOp, ast.Not, ast.Constant)
        self.assertTrue(all(isinstance(node, allowed) for node in ast.walk(tree)))
        return eval(compile(tree, "workflow condition", "eval"), {"__builtins__": {}}, {})

    def test_manual_verification_never_publishes_or_triggers_production_deploy(self):
        root = Path(__file__).resolve().parents[3]
        backend = (root / ".github/workflows/backend.yml").read_text()
        deploy = (root / ".github/workflows/deploy.yml").read_text()
        publish = self.condition(self.job(backend, "build-and-push"))
        verify = self.condition(self.job(backend, "verify-coach-provider"))
        deploy_gate = self.condition(self.job(deploy, "deploy"))
        for event, enabled, publication, verification in (
                ("push", False, True, False), ("pull_request", False, False, False),
                ("workflow_dispatch", False, True, False), ("workflow_dispatch", True, False, True)):
            values = {"github.event_name": event, "inputs.verify_coach_provider": enabled}
            with self.subTest(event=event, enabled=enabled):
                self.assertEqual(self.evaluate(publish, values), publication)
                self.assertEqual(self.evaluate(verify, values), verification)
        for branch in ("main", "codex/gym-feedback"):
            self.assertFalse(self.evaluate(deploy_gate, {
                "github.event_name": "workflow_run", "github.event.workflow_run.conclusion": "success",
                "github.event.workflow_run.head_branch": branch, "github.event.workflow_run.event": "workflow_dispatch",
                "inputs.verify_coach_only": False,
            }))
        self.assertTrue(self.evaluate(deploy_gate, {
            "github.event_name": "workflow_run", "github.event.workflow_run.conclusion": "success",
            "github.event.workflow_run.head_branch": "main", "github.event.workflow_run.event": "push",
            "inputs.verify_coach_only": False,
        }))
        job = self.job(backend, "verify-coach-provider")
        self.assertIn("contents: read", job)
        self.assertIn("push: false", job)
        self.assertIn("load: true", job)
        self.assertIn('DOCKER_BUILD_RECORD_UPLOAD: "false"', job)
        self.assertIn("DOCKER_BUILD_RECORD_UPLOAD: ${{ inputs.verify_coach_provider && 'false' || 'true' }}", self.job(backend, "test"))
        self.assertNotIn("push: true", job)
        self.assertNotIn(":latest", job)
        self.assertNotIn("docker/login-action", job)
        self.assertEqual(re.findall(r"secrets\.([A-Z_]+)", job), ["ANTHROPIC_API_KEY"])
        self.assertEqual(re.findall(r"\$\{\{ runner.temp \}\}/([^\n]+)", job), [
            "coach-provider-evidence/coach-provider-run.json", "coach-provider-evidence/coach-provider-acceptance.json",
        ])
        self.assertRegex(backend, r"verify_coach_provider:\n(?:[^\n]*\n){2}        default: false")



if __name__ == "__main__":
    unittest.main()
