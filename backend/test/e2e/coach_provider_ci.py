#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import time
import uuid


class VerificationFailure(Exception):
    pass


class CoachProviderRun:
    def __init__(self, environment, execute=subprocess.run):
        required = {
            "GITHUB_ACTIONS": "true",
            "RUNNER_ENVIRONMENT": "github-hosted",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "COACH_VERIFY_PROVIDER": "true",
        }
        if any(environment.get(key) != value for key, value in required.items()):
            raise VerificationFailure("manual_hosted_runner_required")
        self.sha = environment.get("GITHUB_SHA", "")
        self.run_id = environment.get("GITHUB_RUN_ID", "")
        self.attempt = environment.get("GITHUB_RUN_ATTEMPT", "")
        if not re.fullmatch(r"[0-9a-f]{40}", self.sha) or not self.run_id.isdigit() or not self.attempt.isdigit():
            raise VerificationFailure("invalid_run_identity")
        if environment.get("GITHUB_REPOSITORY") != "neigrok/windmill-monorepo":
            raise VerificationFailure("unexpected_repository")
        self.root = Path(environment["GITHUB_WORKSPACE"]).resolve()
        self.temp = Path(environment["RUNNER_TEMP"]).resolve()
        self.evidence = self.temp / "coach-provider-evidence"
        self.key = environment.get("ANTHROPIC_API_KEY", "")
        self.execute = execute
        self.process_env = {key: environment[key] for key in ("PATH", "HOME", "LANG") if key in environment}
        self.image = "windmill-coach-verify:" + self.sha
        self.name = "coach-verify-" + uuid.uuid4().hex
        self.network = None
        self.containers = []
        self.database = None
        self.server = None
        self.database_ready = False
        self.account_id = "9ecbfa85-6003-426d-a06e-56f5a78b543d"
        self.email = "coach-provider-ci@example.invalid"
        self.database_url = "postgresql://coach_verify@db:5432/coach_verify"
        self.report = {
            "sourceSha": self.sha,
            "githubRunId": self.run_id,
            "githubRunAttempt": self.attempt,
            "githubRunUrl": f"https://github.com/neigrok/windmill-monorepo/actions/runs/{self.run_id}",
            "provider": "anthropic",
            "providerBaseUrl": "https://api.anthropic.com",
            "expectedModel": "claude-opus-5",
            "syntheticDataOnly": True,
            "maxNewRequests": 3,
            "status": "failed",
            "stage": "preflight",
            "usage": [],
        }

    def command(self, stage, arguments, *, data=None, timeout=90, provider_key=False, allow_failure=False):
        environment = dict(self.process_env)
        if provider_key:
            environment["ANTHROPIC_API_KEY"] = self.key
        try:
            result = self.execute(arguments, input=data, capture_output=True, text=True,
                                  timeout=timeout, env=environment, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise VerificationFailure(stage) from None
        if result.returncode and not allow_failure:
            raise VerificationFailure(stage)
        return result

    def docker(self, stage, *arguments, **options):
        return self.command(stage, ["docker", "--host", "unix:///var/run/docker.sock", *arguments], **options)

    def create_container(self, stage, arguments, *, provider_key=False):
        result = self.docker(stage, "create", *arguments, provider_key=provider_key)
        container = result.stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{64}", container):
            raise VerificationFailure(stage)
        self.containers.append(container)
        return container

    def sql(self, stage, statement):
        return self.docker(stage, "exec", "-i", self.database, "psql", "-X", "-qAt",
                           "-v", "ON_ERROR_STOP=1", "-U", "coach_verify", "-d", "coach_verify",
                           data=statement).stdout

    def start(self, private):
        if not self.key:
            raise VerificationFailure("provider_key_not_configured")
        checkout = self.command("checkout_identity", ["git", "-C", str(self.root), "rev-parse", "HEAD"]).stdout.strip()
        if checkout != self.sha:
            raise VerificationFailure("checkout_identity")
        image = self.docker("candidate_image_identity", "image", "inspect", "--format",
                            '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}', self.image).stdout.strip()
        if not re.fullmatch(r"sha256:[0-9a-f]{64}\|" + self.sha, image):
            raise VerificationFailure("candidate_image_identity")
        self.report["imageId"] = image.split("|")[0]
        self.network = self.docker("network_create", "network", "create", "--label",
                                   "windmill.coach-verification=" + self.name, self.name).stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{64}", self.network):
            self.network = None
            raise VerificationFailure("network_create")
        self.database = self.create_container("database_create", [
            "--name", self.name + "-db", "--network", self.network, "--network-alias", "db",
            "--cpus", "1", "--memory", "512m", "--pids-limit", "128",
            "--tmpfs", "/var/lib/postgresql/data:rw,size=512m",
            "--env", "POSTGRES_USER=coach_verify", "--env", "POSTGRES_DB=coach_verify",
            "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16",
        ])
        self.docker("database_start", "start", self.database)
        for attempt in range(60):
            ready = self.docker("database_ready", "exec", self.database, "pg_isready", "-U", "coach_verify",
                                "-d", "coach_verify", timeout=5, allow_failure=True)
            if ready.returncode == 0:
                self.database_ready = True
                break
            time.sleep(1)
        if not self.database_ready:
            raise VerificationFailure("database_ready")
        self.sql("schema_apply", (self.root / "backend/db/schema.sql").read_text())
        token = secrets.token_hex(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        expires = int(time.time() * 1000) + 3_600_000
        self.sql("synthetic_account_seed", f"""
            INSERT INTO users(id,email,name) VALUES ('{self.account_id}','{self.email}','Synthetic Coach verifier');
            INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('{digest}','{self.account_id}',{expires});
        """)
        session_file = private / "session.json"
        session_file.write_text(json.dumps({"token": token, "accountId": self.account_id,
                                            "email": self.email, "syntheticAccount": True}))
        session_file.chmod(0o600)
        self.server = self.create_container("candidate_create", [
            "--name", self.name + "-server", "--network", self.network,
            "--publish", "127.0.0.1::8080", "--cpus", "2", "--memory", "1g", "--pids-limit", "256",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
            "--tmpfs", "/app/uploads:rw,uid=10001,gid=10001,size=16m", "--tmpfs", "/tmp:rw,size=16m",
            "--env", "DATABASE_URL=" + self.database_url, "--env", "PORT=8080",
            "--env", "WINDMILL_APP_URL=http://localhost", "--env", "WINDMILL_API_URL=http://localhost",
            "--env", "COACH_ANTHROPIC_BASE_URL=https://api.anthropic.com", "--env", "ANTHROPIC_API_KEY",
            "--env", "TENDING_ENABLED=false", "--env", "REMINDERS_ENABLED=false",
            "--env", "JOURNAL_NUDGE_ENABLED=false", "--env", "JOURNAL_EMBEDDER_URL=",
            "--env", "RESEND_API_KEY=", "--env", "OPENAI_API_KEY=", "--env", "SENTRY_DSN=",
            "--env", "AMPLITUDE_API_KEY=", "--env", "WINDMILL_MCP_TOKEN=",
            "--env", "WINDMILL_EVENTS_RETENTION_DAYS=0", "--env", "WINDMILL_FEEDBACK_RETENTION_DAYS=0",
            "--env", "WINDMILL_SERVER_ERROR_RETENTION_DAYS=0", self.image,
        ], provider_key=True)
        self.docker("candidate_start", "start", self.server)
        for attempt in range(60):
            ready = self.docker("candidate_ready", "exec", self.server, "curl", "--silent", "--output", "/dev/null",
                                "--max-time", "2", "http://127.0.0.1:8080/", timeout=5, allow_failure=True)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise VerificationFailure("candidate_ready")
        address = self.docker("candidate_port", "port", self.server, "8080/tcp").stdout.strip()
        if not re.fullmatch(r"127\.0\.0\.1:[0-9]{1,5}", address):
            raise VerificationFailure("candidate_port")
        return "http://" + address, session_file

    def collect_usage(self):
        raw = self.sql("usage_read", f"""
            SELECT json_build_object(
              'generations', (SELECT count(*) FROM gym_ask_generations WHERE user_id='{self.account_id}'),
              'routines', (SELECT count(*) FROM gym_routines WHERE user_id='{self.account_id}'),
              'usage', COALESCE((SELECT json_agg(json_build_object(
                'runId', run_id, 'model', model, 'outcome', outcome, 'iteration', iteration,
                'inputTokens', input_tokens, 'outputTokens', output_tokens,
                'cacheReadTokens', cache_read_tokens, 'cacheWriteTokens', cache_write_tokens,
                'costNanos', cost_nanos, 'costFloorNanos', cost_floor_nanos) ORDER BY id)
                FROM ai_usage WHERE user_id='{self.account_id}' AND product='gym'), '[]'::json));
        """)
        summary = json.loads(raw)
        if not isinstance(summary, dict) or set(summary) != {"generations", "routines", "usage"}:
            raise VerificationFailure("usage_shape")
        for field in ("generations", "routines"):
            if type(summary[field]) is not int or summary[field] < 0:
                raise VerificationFailure("usage_shape")
        fields = {"runId", "model", "outcome", "iteration", "inputTokens", "outputTokens",
                  "cacheReadTokens", "cacheWriteTokens", "costNanos", "costFloorNanos"}
        outcomes = {"ok", "truncated", "refused", "rate_limited", "transport", "schema_invalid"}
        if not isinstance(summary["usage"], list):
            raise VerificationFailure("usage_shape")
        for row in summary["usage"]:
            if not isinstance(row, dict) or set(row) != fields:
                raise VerificationFailure("usage_shape")
            if row["model"] != "claude-opus-5" or row["outcome"] not in outcomes or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", row["runId"]):
                raise VerificationFailure("usage_shape")
            for field in fields - {"runId", "model", "outcome"}:
                if field == "costNanos" and row[field] is None:
                    continue
                if type(row[field]) is not int or row[field] < 0:
                    raise VerificationFailure("usage_shape")
        self.report.update(summary)
        model_runs = len({row["runId"] for row in summary["usage"]})
        self.report["modelRuns"] = model_runs
        if summary["generations"] > 3 or len(summary["usage"]) > 24 or model_runs > summary["generations"]:
            raise VerificationFailure("request_limit_exceeded")

    def cleanup(self):
        clean = True
        for container in reversed(self.containers):
            try:
                clean = self.docker("container_cleanup", "rm", "--force", container, timeout=20,
                                    allow_failure=True).returncode == 0 and clean
            except VerificationFailure:
                clean = False
        if self.network:
            try:
                clean = self.docker("network_cleanup", "network", "rm", self.network, timeout=20,
                                    allow_failure=True).returncode == 0 and clean
            except VerificationFailure:
                clean = False
        return clean

    def run(self):
        self.evidence.mkdir(mode=0o700, exist_ok=False)
        try:
            with tempfile.TemporaryDirectory(prefix="coach-provider-private-", dir=self.temp) as directory:
                base_url, session_file = self.start(Path(directory))
                self.report["stage"] = "acceptance"
                environment = dict(self.process_env,
                                   COACH_TEST_CANDIDATE_SHA=self.sha,
                                   COACH_TEST_PROVIDER_MARKER="anthropic-production-configured")
                try:
                    outcome = self.execute([sys.executable, str(self.root / "backend/test/e2e/coach_provider_acceptance.py"),
                                            "--execute", "--base-url", base_url, "--session-file", str(session_file),
                                            "--evidence-dir", str(self.evidence)],
                                           env=environment, capture_output=True, text=True, timeout=600, check=False)
                except (OSError, subprocess.TimeoutExpired):
                    raise VerificationFailure("acceptance_timeout") from None
                if outcome.returncode == 3:
                    self.report.update(status="inconclusive", stage="acceptance_inconclusive")
                elif outcome.returncode:
                    raise VerificationFailure("acceptance_failed")
                else:
                    self.report.update(status="passed", stage="complete")
        except VerificationFailure as error:
            self.report.update(status="failed", stage=str(error))
        except Exception:
            self.report.update(status="failed", stage="unexpected_bootstrap_failure")
        finally:
            if self.server:
                try:
                    self.docker("candidate_stop", "stop", "--time", "5", self.server, timeout=15)
                except VerificationFailure:
                    self.report.update(status="failed", stage="candidate_stop")
            if self.database_ready:
                try:
                    self.collect_usage()
                    if self.report["status"] == "passed" and not self.report["usage"]:
                        raise VerificationFailure("provider_usage_missing")
                except Exception:
                    self.report.update(status="failed", stage="usage_validation")
            self.report["resourcesRemoved"] = self.cleanup()
            if not self.report["resourcesRemoved"]:
                self.report.update(status="failed", stage="resource_cleanup")
            (self.evidence / "coach-provider-run.json").write_text(json.dumps(self.report, indent=2) + "\n")
        return {"passed": 0, "inconclusive": 3}.get(self.report["status"], 1)


def main():
    def interrupted(signum, frame):
        raise VerificationFailure("runner_interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(900)
    try:
        run = CoachProviderRun(os.environ)
        result = run.run()
        print("Coach provider verification: " + run.report["status"] + " (" + run.report["stage"] + ")")
        return result
    except Exception:
        print("Coach provider verification could not start; no credential values were logged.")
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
