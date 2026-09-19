#!/usr/bin/env python3
import hashlib
import http.client
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

from coach_provider_ci import VerificationFailure


class DeployedCoachRun:
    def __init__(self, environment, execute=subprocess.run, connection=http.client.HTTPSConnection, pause=time.sleep):
        required = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                    "GITHUB_EVENT_NAME": "workflow_dispatch", "COACH_VERIFY_DEPLOYED": "true",
                    "GITHUB_REPOSITORY": "neigrok/windmill-monorepo"}
        if any(environment.get(key) != value for key, value in required.items()):
            raise VerificationFailure("manual_hosted_runner_required")
        self.sha = environment.get("EXPECTED_IMAGE_SHA", "")
        self.source_sha = environment.get("GITHUB_SHA", "")
        self.run_id = environment.get("GITHUB_RUN_ID", "")
        self.attempt = environment.get("GITHUB_RUN_ATTEMPT", "")
        if not all(re.fullmatch(r"[0-9a-f]{40}", value) for value in (self.sha, self.source_sha)) or not self.run_id.isdigit() or not self.attempt.isdigit():
            raise VerificationFailure("full_expected_sha_and_run_identity_required")
        self.host = environment.get("SSH_HOST", "")
        self.user = environment.get("SSH_USER", "")
        self.port = environment.get("SSH_PORT") or "22"
        self.key = environment.get("SSH_KEY", "")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.:-]*", self.host) or not re.fullmatch(r"[a-z_][a-z0-9_-]*", self.user):
            raise VerificationFailure("deployment_access_not_configured")
        if not self.port.isdigit() or not 1 <= int(self.port) <= 65535 or not self.key:
            raise VerificationFailure("deployment_access_not_configured")
        self.root = Path(environment["GITHUB_WORKSPACE"]).resolve()
        self.temp = Path(environment["RUNNER_TEMP"]).resolve()
        self.evidence = self.temp / "coach-deployed-evidence"
        self.execute, self.connection, self.pause = execute, connection, pause
        self.process_env = {key: environment[key] for key in ("PATH", "HOME", "LANG") if key in environment}
        self.repository = "ghcr.io/neigrok/windmill-monorepo"
        self.image = self.repository + ":" + self.sha
        self.account = str(uuid.uuid4())
        self.email = "coach-smoke-" + self.account.replace("-", "") + "@example.invalid"
        self.marker = "Coach smoke " + self.run_id + "/" + self.attempt + "/" + secrets.token_hex(12)
        self.token = secrets.token_hex(32)
        self.digest = hashlib.sha256(self.token.encode()).hexdigest()
        self.created = False
        self.seed_attempted = False
        self.ssh = []
        self.report = {
            "expectedDeployedSha": self.sha, "verifierSourceSha": self.source_sha,
            "githubRunId": self.run_id, "githubRunAttempt": self.attempt,
            "githubRunUrl": "https://github.com/neigrok/windmill-monorepo/actions/runs/" + self.run_id,
            "publicOrigin": "https://windmill.works", "provider": "anthropic", "expectedModel": "claude-opus-5",
            "syntheticDataOnly": True, "maxNewRequests": 3, "status": "failed", "stage": "preflight",
            "fixture": {"accountId": self.account, "email": self.email, "marker": self.marker, "created": False},
            "cleanup": {"accountRemoved": False, "sessionRevoked": False, "remainingFixture": False},
        }

    def command(self, stage, arguments, *, data=None, timeout=45, environment=None):
        try:
            result = self.execute(arguments, input=data, capture_output=True, text=True, timeout=timeout,
                                  env=self.process_env if environment is None else environment, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise VerificationFailure(stage) from None
        if result.returncode:
            raise VerificationFailure(stage)
        return result.stdout

    def remote(self, stage, script):
        return self.command(stage, [*self.ssh, "bash", "-seu"], data=script)

    def sql(self, stage, statement):
        return self.remote(stage, "cd \"$HOME/windmill\"\ndocker compose exec -T db psql -X -qAt -v ON_ERROR_STOP=1 -U windmill windmill <<'COACH_SQL'\n"
                           "SET lock_timeout='3s'; SET statement_timeout='10s';\n" + statement + "\nCOACH_SQL\n")

    def identity(self):
        manifest = json.loads(self.command("registry_identity", ["docker", "--host", "unix:///var/run/docker.sock",
            "buildx", "imagetools", "inspect", "--format", "{{json .Manifest}}", self.image], timeout=90))
        digest = manifest.get("digest", "")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise VerificationFailure("registry_identity")
        raw = self.remote("deployed_identity", '''cd "$HOME/windmill"
container=$(docker compose ps -q server)
test -n "$container"
docker inspect --format '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}}}' "$container"
image=$(docker inspect --format '{{.Image}}' "$container")
docker image inspect --format '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}' "$image"
''')
        lines = raw.strip().splitlines()
        if len(lines) != 2:
            raise VerificationFailure("deployed_identity")
        server, image = [json.loads(line) for line in lines]
        if (server.get("image") != self.image or server.get("running") is not True or server.get("health") != "healthy"
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", server.get("imageId", ""))
                or image.get("id") != server["imageId"] or self.repository + "@" + digest not in image.get("repoDigests", [])):
            raise VerificationFailure("deployed_image_mismatch")
        return {"image": self.image, "imageId": server["imageId"], "registryDigest": digest, "health": "healthy"}

    def owner_clause(self):
        return f"id='{self.account}'::uuid AND email='{self.email}' AND name='{self.marker}'"

    def state(self):
        raw = self.sql("fixture_state", f"""
            WITH owner AS (SELECT id FROM users WHERE {self.owner_clause()})
            SELECT json_build_object('owned', EXISTS(SELECT 1 FROM owner),
              'generations', (SELECT count(*) FROM gym_ask_generations WHERE user_id IN (SELECT id FROM owner)),
              'active', COALESCE((SELECT json_agg(json_build_object('thread',thread_id,'requestId',request_id))
                FROM gym_ask_generations WHERE user_id IN (SELECT id FROM owner) AND payload->>'status'='running'), '[]'::json));
        """)
        state = json.loads(raw)
        if set(state) != {"owned", "generations", "active"} or state["owned"] is not True:
            raise VerificationFailure("fixture_ownership_not_proven")
        if type(state["generations"]) is not int or not 0 <= state["generations"] <= 3 or not isinstance(state["active"], list) or len(state["active"]) > 3:
            raise VerificationFailure("fixture_request_bound")
        for request in state["active"]:
            if set(request) != {"thread", "requestId"} or not all(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,64}", value) for value in request.values()):
                raise VerificationFailure("fixture_request_identity")
        return state

    def usage(self):
        raw = self.sql("fixture_usage", f"""
            SELECT COALESCE(json_agg(json_build_object('runId',run_id,'model',model,'outcome',outcome,
              'iteration',iteration,'inputTokens',input_tokens,'outputTokens',output_tokens,
              'cacheReadTokens',cache_read_tokens,'cacheWriteTokens',cache_write_tokens,
              'costNanos',cost_nanos,'costFloorNanos',cost_floor_nanos) ORDER BY id),'[]'::json)
            FROM ai_usage WHERE user_id='{self.account}'::uuid AND product='gym'
              AND EXISTS(SELECT 1 FROM users WHERE {self.owner_clause()});
        """)
        rows = json.loads(raw)
        numbers = {"iteration", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costNanos", "costFloorNanos"}
        if not isinstance(rows, list) or len(rows) > 24:
            raise VerificationFailure("fixture_usage_shape")
        for row in rows:
            if set(row) != numbers | {"runId", "model", "outcome"} or row["model"] != "claude-opus-5":
                raise VerificationFailure("fixture_usage_shape")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", row["runId"]) or row["outcome"] not in {"ok", "truncated", "refused", "rate_limited", "transport", "schema_invalid"}:
                raise VerificationFailure("fixture_usage_shape")
            if any(not (field == "costNanos" and row[field] is None) and (type(row[field]) is not int or row[field] < 0) for field in numbers):
                raise VerificationFailure("fixture_usage_shape")
        self.report["usage"] = rows
        self.report["modelRuns"] = len({row["runId"] for row in rows})
        if self.report["modelRuns"] > 3:
            raise VerificationFailure("fixture_request_bound")

    def cleanup(self):
        if not self.seed_attempted:
            return
        removed = False
        try:
            if not self.created:
                raise VerificationFailure("fixture_creation_not_proven")
            state = self.state()
            for request in state["active"]:
                connection = self.connection("windmill.works", timeout=10)
                try:
                    connection.request("POST", f"/v1/gym/threads/{request['thread']}/generations/{request['requestId']}/stop",
                                       body=b"", headers={"Authorization": "Bearer " + self.token})
                    response = connection.getresponse()
                    response.read(65537)
                    if response.status != 200:
                        raise VerificationFailure("fixture_stop")
                finally:
                    connection.close()
            for attempt in range(12):
                state = self.state()
                if not state["active"]:
                    break
                self.pause(1)
            else:
                raise VerificationFailure("fixture_not_quiescent")
            self.usage()
            if self.report["modelRuns"] > state["generations"]:
                raise VerificationFailure("fixture_replay_spent_again")
            if self.report["status"] == "passed" and not self.report["usage"]:
                self.report.update(status="failed", stage="provider_usage_missing")
            result = self.sql("fixture_remove", f"""
                BEGIN;
                DO $coach$ DECLARE row RECORD; removed_count INTEGER;
                BEGIN
                  PERFORM 1 FROM users WHERE {self.owner_clause()} FOR UPDATE;
                  IF NOT FOUND THEN RAISE EXCEPTION 'fixture ownership'; END IF;
                  IF EXISTS(SELECT 1 FROM sessions WHERE user_id='{self.account}'::uuid AND token_hash<>'{self.digest}')
                    THEN RAISE EXCEPTION 'unexpected session'; END IF;
                  FOR row IN SELECT id FROM gym_ask_threads WHERE user_id='{self.account}'::uuid LOOP
                    IF NOT pg_try_advisory_xact_lock(hashtextextended('gym-ask:' || row.id,0))
                      THEN RAISE EXCEPTION 'active fixture lease'; END IF;
                  END LOOP;
                  IF EXISTS(SELECT 1 FROM gym_ask_generations WHERE user_id='{self.account}'::uuid AND payload->>'status'='running')
                    THEN RAISE EXCEPTION 'active fixture generation'; END IF;
                  DELETE FROM sessions WHERE user_id='{self.account}'::uuid AND token_hash='{self.digest}';
                  DELETE FROM users WHERE {self.owner_clause()};
                  GET DIAGNOSTICS removed_count = ROW_COUNT;
                  IF removed_count<>1 THEN RAISE EXCEPTION 'fixture removal'; END IF;
                END $coach$;
                COMMIT;
                SELECT 'removed';
            """)
            if result.strip() != "removed":
                raise VerificationFailure("fixture_remove_unconfirmed")
            removed = True
            self.report["cleanup"].update(accountRemoved=True, sessionRevoked=True, remainingFixture=False)
        except Exception:
            self.report["cleanup"]["remainingFixture"] = True
            self.report.update(status="failed", stage="fixture_retained_for_review")
        finally:
            if not removed:
                try:
                    result = self.sql("fixture_session_revoke", f"DELETE FROM sessions WHERE user_id='{self.account}'::uuid AND token_hash='{self.digest}'; SELECT 'revoked';")
                    self.report["cleanup"]["sessionRevoked"] = result.strip() == "revoked"
                except Exception:
                    self.report["cleanup"]["sessionRevoked"] = False

    def run(self):
        self.evidence.mkdir(mode=0o700, exist_ok=False)
        with tempfile.TemporaryDirectory(prefix="coach-deployed-private-", dir=self.temp) as directory:
            private = Path(directory)
            key = private / "deploy_key"
            key.write_text(self.key)
            key.chmod(0o600)
            self.ssh = ["ssh", "-F", "/dev/null", "-i", str(key), "-p", self.port,
                        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new",
                        "-o", "UserKnownHostsFile=" + str(private / "known_hosts"), "-o", "ConnectTimeout=10",
                        "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", "--", self.user + "@" + self.host]
            try:
                checkout = self.command("verifier_identity", ["git", "-C", str(self.root), "rev-parse", "HEAD"]).strip()
                if checkout != self.source_sha:
                    raise VerificationFailure("verifier_identity")
                self.report["before"] = self.identity()
                self.seed_attempted = True
                expires = int(time.time() * 1000) + 1_800_000
                seeded = self.sql("fixture_seed", f"""
                    BEGIN;
                    INSERT INTO users(id,email,name) VALUES ('{self.account}','{self.email}','{self.marker}');
                    INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('{self.digest}','{self.account}',{expires});
                    COMMIT;
                    SELECT '{self.account}';
                """)
                if seeded.strip() != self.account:
                    raise VerificationFailure("fixture_seed_unconfirmed")
                self.created = True
                self.report["fixture"]["created"] = True
                session_file = private / "session.json"
                session_file.write_text(json.dumps({"token": self.token, "accountId": self.account,
                                                    "email": self.email, "syntheticAccount": True}))
                session_file.chmod(0o600)
                environment = dict(self.process_env, COACH_TEST_CANDIDATE_SHA=self.sha,
                                   COACH_TEST_PROVIDER_MARKER="anthropic-production-configured")
                try:
                    outcome = self.execute([sys.executable, str(self.root / "backend/test/e2e/coach_provider_acceptance.py"),
                        "--execute", "--allow-remote", "--base-url", "https://windmill.works",
                        "--session-file", str(session_file), "--evidence-dir", str(self.evidence)],
                        env=environment, capture_output=True, text=True, timeout=600, check=False)
                    self.report.update(status={0: "passed", 3: "inconclusive"}.get(outcome.returncode, "failed"),
                                       stage={0: "complete", 3: "acceptance_inconclusive"}.get(outcome.returncode, "acceptance_failed"))
                finally:
                    self.report["after"] = self.identity()
                    if self.report["before"] != self.report["after"]:
                        raise VerificationFailure("deployed_image_changed")
            except VerificationFailure as error:
                self.report.update(status="failed", stage=str(error))
            except Exception:
                self.report.update(status="failed", stage="deployed_verification_failed")
            finally:
                self.cleanup()
                (self.evidence / "coach-provider-deployed.json").write_text(json.dumps(self.report, indent=2) + "\n")
        return {"passed": 0, "inconclusive": 3}.get(self.report["status"], 1)


def main():
    def interrupted(signum, frame):
        raise VerificationFailure("runner_interrupted")

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
        signal.signal(signum, interrupted)
    signal.alarm(1000)
    try:
        run = DeployedCoachRun(os.environ)
        result = run.run()
        print("Deployed Coach verification: " + run.report["status"] + " (" + run.report["stage"] + ")")
        return result
    except Exception:
        print("Deployed Coach verification could not start; no private access details were logged.")
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
