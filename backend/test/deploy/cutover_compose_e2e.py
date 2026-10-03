#!/usr/bin/env python3
# Real Docker cutover regression with production services and REST-created history.
import argparse
import fnmatch
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
BACKEND = Path(__file__).resolve().parents[2]
ROOT = BACKEND.parent
REPOSITORY = "ghcr.io/neigrok/windmill-monorepo"
SWITCHES = {"GYM_ENGINE_WRITES": "1", "JOURNAL_ENGINE_WRITES": "1",
            "GYM_WRITE_FREEZE": "0", "JOURNAL_WRITE_FREEZE": "0", "SYNC_ENABLED": "0"}
ACCOUNTS = [f"90000000-0000-4000-8000-{index:012d}" for index in (1, 2)]
REMOTE = '''main() {
  cd "$1"
  bash "$2" "$1"
}
main "$1" "$2" < /dev/null
'''
PROXY = '''#!/usr/bin/env python3
import os
from pathlib import Path
import signal
import sys
arguments = sys.argv[1:]
marker = os.environ.get("WM_E2E_FAIL_PREPARE")
if marker and arguments == ["compose", "config", "-q"]:
    values = dict(line.split("=", 1) for line in Path(".env").read_text().splitlines() if "=" in line)
    target = Path(marker)
    if target.exists() and all(values.get(key) == "1" for key in ("GYM_ENGINE_WRITES", "JOURNAL_ENGINE_WRITES")):
        target.rename(str(target) + ".fired")
        sys.exit(79)
marker = os.environ.get("WM_E2E_KILL_DEPLOY_AFTER_PROMOTION")
if marker and arguments == ["compose", "up", "-d", "--pull", "never"]:
    target = Path(marker)
    if target.exists():
        assert not Path("Caddyfile.next").exists(), "Caddyfile has not been promoted"
        target.rename(str(target) + ".fired")
        os.kill(os.getppid(), signal.SIGKILL)
        sys.exit(137)
os.execv(os.environ["WM_E2E_REAL_DOCKER"], [os.environ["WM_E2E_REAL_DOCKER"], *arguments])
'''
ROWS = r'''SET timezone='UTC';
SELECT format('SELECT jsonb_build_object(''table'', %L, ''rows'', coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"), ''[]''::jsonb))::text FROM %I.%I t;',
              schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%'
ORDER BY schemaname, tablename
\gexec
SELECT format('SELECT jsonb_build_object(''sequence'', %L, ''last_value'', last_value, ''is_called'', is_called)::text FROM %I.%I;',
              sequence_schema || '.' || sequence_name, sequence_schema, sequence_name)
FROM information_schema.sequences WHERE sequence_schema NOT IN ('pg_catalog','information_schema')
ORDER BY sequence_schema, sequence_name
\gexec
'''


class Harness:
    def __init__(self, directory, dry_run):
        self.directory = directory
        self.work = directory / "home/windmill"
        self.work.mkdir(parents=True)
        self.identifier = "wm-cutover-e2e-" + uuid.uuid4().hex[:12]
        self.builder = self.identifier + "-builder"
        self.tags = [self.identifier + "-old", self.identifier + "-current"]
        self.images = [REPOSITORY + ":" + tag for tag in self.tags]
        self.dry_run = dry_run
        self.environment = dict(os.environ)
        # Exported settings must not override the rendered .env under test.
        for key in (*SWITCHES, "IMAGE_TAG", "HARNESS_CURRENT_TAG", "POSTGRES_PASSWORD",
                    "DOMAIN_APP", "DOMAIN_API", "CF_IPS", "ACME_EMAIL", "COMPOSE_FILE"):
            self.environment.pop(key, None)
        self.environment.update(COMPOSE_PROJECT_NAME=self.identifier, COMPOSE_ANSI="never")
        self.docker = shutil.which("docker")
        self.builder_created = False
        self.created_images = []
        self.pulled_images = []
        self.check_name = "setup"
        self.calls = 0
        self.layout()

    def run(self, arguments, *, input=None, env=None, cwd=None, okay=True, timeout=180):
        self.calls += 1
        result = subprocess.run([str(value) for value in arguments], input=input, capture_output=True,
                                cwd=cwd or self.work, env=env or self.environment, timeout=timeout)
        (self.directory / f"command-{self.calls:03d}.log").write_bytes(result.stdout + result.stderr)
        if okay and result.returncode:
            raise AssertionError(f"{arguments[0]} exited {result.returncode}: "
                                 + (result.stdout + result.stderr)[-6000:].decode(errors="replace"))
        return result

    def compose(self, *arguments, **kwargs):
        return self.run([self.docker, "compose", *arguments], **kwargs)

    def layout(self):
        compose = (BACKEND / "deploy/docker-compose.yml").read_text()
        # Keep production's services, migration command, dependencies and mounts.
        # These exact replacements fail closed if production's layout changes.
        assert compose.count('      - "80:80"') == compose.count('      - "443:443"') == 1
        compose = compose.replace('      - "80:80"', '      - "127.0.0.1::80"').replace('      - "443:443"\n', '')
        start = re.search(r"^  embedder:\n", compose, re.M).start()
        end = re.search(r"^  caddy:\n", compose, re.M).start()
        compose = compose[:start] + '''  embedder:
    image: ghcr.io/neigrok/windmill-monorepo:${HARNESS_CURRENT_TAG}
    restart: unless-stopped
    command: ["python3", "-m", "http.server", "8081"]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8081/"]
      interval: 1s
      timeout: 3s
      retries: 30

''' + compose[end:]
        compose = re.sub(r"^(    image: .+)$", r"\1\n    pull_policy: never", compose, flags=re.M)
        (self.work / "docker-compose.yml").write_text(compose)
        caddy = (BACKEND / "deploy/Caddyfile").read_text()
        for site in ("DOMAIN_APP", "DOMAIN_API"):
            pattern = "{$" + site + "} {"
            assert caddy.count(pattern) == 1
            caddy = caddy.replace(pattern, "http://" + pattern)
        (self.work / "Caddyfile").write_text(caddy)
        shutil.copyfile(BACKEND / "deploy/deploy-production.sh", self.work / "deploy-production.sh")
        shutil.copyfile(BACKEND / "deploy/gym-migration/cutover-production.sh", self.work / "products-cutover.sh")
        (self.work / "web/models").mkdir(parents=True)
        (self.work / "web/index.html").write_text("cutover e2e\n")
        self.values = {**SWITCHES, "GYM_ENGINE_WRITES": "0", "JOURNAL_ENGINE_WRITES": "0",
                       "IMAGE_TAG": self.tags[0], "HARNESS_CURRENT_TAG": self.tags[1],
                       "POSTGRES_PASSWORD": uuid.uuid4().hex, "DOMAIN_APP": "cutover-app.test",
                       "DOMAIN_API": "cutover-api.test", "ACME_EMAIL": "cutover@example.com",
                       "CF_IPS": "0.0.0.0/0 ::/0", "RESEND_FROM": "cutover@example.com",
                       "REMINDERS_ENABLED": "0", "JOURNAL_NUDGE_ENABLED": "0",
                       "JOURNAL_ECHO_ADMIN_TOKEN": "", "ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": "",
                       "RESEND_API_KEY": "", "WINDMILL_COOKIE_DOMAIN": "",
                       "WINDMILL_OWNER_EMAILS": "cutover-1@example.com,cutover-2@example.com"}
        # Compose gives the shell precedence over .env; don't inherit a host's provider keys.
        for key in re.findall(r"\$\{([A-Z][A-Z_0-9]*)", compose):
            self.environment.pop(key, None)
        self.write_env(".env", self.values)
        proxy = self.directory / "bin/docker"
        proxy.parent.mkdir()
        proxy.write_text(PROXY)
        proxy.chmod(0o755)
        self.environment.update(PATH=str(proxy.parent) + os.pathsep + os.environ["PATH"],
                                WM_E2E_REAL_DOCKER=self.docker or "/nonexistent/docker")

    def write_env(self, name, values):
        path = self.work / name
        path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        path.chmod(0o600)

    def check(self, name, operation):
        self.check_name = name
        operation()
        print("PASS " + name, flush=True)

    def remote(self, script, switches=None, extra=None):
        environment = {**self.environment, **(switches or {}), **(extra or {})}
        return self.run(["bash", "-seuo", "pipefail", "--", self.work, script],
                        input=REMOTE.encode(), env=environment, okay=False, timeout=900)

    def candidate(self, values=None, caddy=None):
        self.write_env("rendered.env", values or self.values)
        shutil.copyfile(self.work / "docker-compose.yml", self.work / "docker-compose.next.yml")
        (self.work / "Caddyfile.next").write_bytes(caddy or (self.work / "Caddyfile").read_bytes())

    def sql(self, sql):
        return self.compose("exec", "-T", "db", "sh", "-ec",
                            'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -XAtq -v ON_ERROR_STOP=1',
                            input=sql.encode()).stdout

    def runtime(self):
        ids = self.compose("ps", "-aq").stdout.decode().split()
        rows = json.loads(self.run([self.docker, "inspect", *ids]).stdout)
        return sorted((row["Id"], row["Image"], sorted(row["Config"]["Env"]), row["State"]["Running"],
                       row["HostConfig"]["RestartPolicy"]) for row in rows)

    def live_files(self):
        return {name: (self.work / name).read_bytes() for name in (".env", "docker-compose.yml", "Caddyfile")}

    def request(self, method, target, account=0, body=None, expected=200):
        # Discover the port again: content changes deliberately recreate Caddy.
        address = self.compose("port", "caddy", "80").stdout.decode().strip()
        port = int(address.rsplit(":", 1)[1])
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
        try:
            headers = {"Host": "cutover-app.test", "Cookie": "wm_session=cutover-" + ACCOUNTS[account]}
            if body is not None:
                headers["Content-Type"] = "application/json"
            connection.request(method, target, json.dumps(body).encode() if body is not None else None, headers)
            response = connection.getresponse()
            payload = response.read()
            assert response.status == expected, (method, target, response.status, payload)
            self.last_headers = dict(response.getheaders())
            if not payload:
                return None
            return json.loads(payload) if "application/json" in response.getheader("Content-Type", "") else payload
        finally:
            connection.close()

    def reads(self):
        return {(account, target): self.request("GET", target, account)
                for account in range(2) for target in (
                    "/v1/gym/routines", "/v1/gym/sessions", f"/v1/gym/sessions/session_history_{account + 1}",
                    "/v1/gym/notes", "/v1/gym/bodyweight", "/v1/gym/preferences",
                    "/v1/journal/pages", "/v1/journal/pages?since=0:0:&limit=1",
                    "/v1/journal/page/2026-01-01", "/v1/journal/export")}

    def build(self):
        assert self.docker, "Docker executable required (use --dry-run without Docker)"
        self.run([self.docker, "info"])
        self.run([self.docker, "compose", "version"])
        assert not self.run([self.docker, "ps", "-aq", "--filter", "name=^/windmill-products-cutover$"]).stdout.strip(), \
            "another cutover runner exists; use an idle local Docker host"
        for image in ("postgres:16", "caddy:2", "moby/buildkit:buildx-stable-1"):
            if self.run([self.docker, "image", "inspect", image], okay=False).returncode:
                self.pulled_images.append(image)
                self.run([self.docker, "pull", image], timeout=600)
        old = self.directory / "origin-main"
        old.mkdir()
        archive = self.run(["git", "-C", ROOT, "archive", "origin/main"], timeout=60).stdout
        archive_path = self.directory / "origin-main.tar"
        archive_path.write_bytes(archive)
        with tarfile.open(archive_path) as source:
            # Git archive only contains repository paths, never an untrusted tarball.
            for member in source.getmembers():
                assert not member.name.startswith("/") and ".." not in Path(member.name).parts
            source.extractall(old)
        self.builder_created = True
        # The image builds with -j$(nproc); six CPUs keep its C++ compilers inside an 8 GB Docker VM.
        self.run([self.docker, "buildx", "create", "--name", self.builder, "--driver", "docker-container",
                  "--driver-opt", "image=moby/buildkit:buildx-stable-1",
                  "--driver-opt", "cpuset-cpus=0-" + str(min(6, os.cpu_count() or 1) - 1)])
        for tree, image in ((old, self.images[0]), (ROOT, self.images[1])):
            self.created_images.append(image)
            self.run([self.docker, "buildx", "build", "--builder", self.builder, "--load",
                      "--target", "runtime", "--build-context", "contract=" + str(tree / "packages/api-contract"),
                      "--label", "io.windmill.cutover-e2e=" + self.identifier, "-t", image, tree / "backend"],
                     timeout=3600)

    def seed(self):
        self.compose("up", "-d", "--wait", "--wait-timeout", "180", "--pull", "never", timeout=240)
        for index, account in enumerate(ACCOUNTS, 1):
            digest = hashlib.sha256(("cutover-" + account).encode()).hexdigest()
            self.sql(f"INSERT INTO users(id,email) VALUES ('{account}','cutover-{index}@example.com');\n"
                     f"INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('{digest}','{account}',99999999999999);\n")
            self.request("POST", "/v1/gym/routines", index - 1,
                         {"id": f"routine_history_{index}", "name": "History " + str(index), "position": 1,
                          "entries": [{"exerciseId": "back-squat"}]})
            started = 1767225600000 + index * 100000
            self.request("POST", "/v1/gym/sessions/import", index - 1,
                         {"id": f"session_history_{index}", "routineId": f"routine_history_{index}", "startedAt": started,
                          "finishedAt": started + 10000,
                          "sets": [{"id": f"set_history_{index}", "exerciseId": "back-squat", "weightKg": 50 + index,
                                    "reps": 5, "completedAt": started + 1000}]}, expected=201)
            self.request("PATCH", f"/v1/gym/sessions/session_history_{index}/sets/set_history_{index}", index - 1, {"reps": 7})
            self.request("PUT", f"/v1/gym/notes/history_{index}", index - 1, {"title": "History", "body": "Before adoption π"})
            self.request("PUT", "/v1/gym/bodyweight/2026-01-01", index - 1, {"weightKg": 80 + index, "recordedAt": started})
            for counter, day in enumerate(("2026-01-01", "2026-01-02"), 1):
                self.request("PUT", "/v1/journal/page/" + day, index - 1,
                             {"body": "Account " + str(index) + " history π", "stamp": f"100:{counter}:e2e", "mood": index})
            self.request("PUT", "/v1/journal/page/2026-01-01", index - 1,
                         {"body": "Revised history " + str(index), "stamp": "101:0:e2e"})
        self.before = self.reads()
        assert all(self.before[(index, "/v1/gym/sessions")]["sessions"] for index in range(2))
        assert all(len(self.before[(index, "/v1/journal/pages")]["pages"]) == 2 for index in range(2))

    def upgrade(self):
        self.values["IMAGE_TAG"] = self.tags[1]
        self.candidate()
        result = self.remote("deploy-production.sh")
        assert result.returncode == 0, (result.stdout + result.stderr).decode()
        self.compose("up", "-d", "--wait", "--wait-timeout", "180", "--pull", "never", timeout=240)
        assert self.reads() == self.before, "old-image history changed during compatible legacy deployment"

    def rollback(self):
        rows, runtime, files = self.sql(ROWS), self.runtime(), self.live_files()
        marker = self.directory / "fail-prepare"
        marker.touch()
        result = self.remote("products-cutover.sh", SWITCHES, {"WM_E2E_FAIL_PREPARE": str(marker)})
        assert result.returncode != 0 and b"restored; old configuration running" in result.stdout, result.stdout.decode()
        assert Path(str(marker) + ".fired").exists(), "failure did not reach post-adoption/pre-start prepare"
        assert self.sql(ROWS) == rows, "rollback rows or sequences differ"
        assert self.live_files() == files and self.runtime() == runtime, "old files/containers/config were not restored"
        assert self.reads() == self.before, "old REST reads differ after rollback"
        assert self.sql("SELECT to_regclass('gym_sync_adoptions') IS NULL AND to_regclass('journal_sync_adoptions') IS NULL;").strip() == b"t"

    def success(self):
        result = self.remote("products-cutover.sh", SWITCHES)
        assert result.returncode == 0 and b"PASS gym and journal cutover" in result.stdout, result.stdout.decode()
        self.values.update(SWITCHES)
        assert self.reads() == self.before, "REST reads differ after adoption"
        server = json.loads(self.run([self.docker, "inspect", self.compose("ps", "-q", "server").stdout.decode().strip()]).stdout)[0]
        environment = dict(entry.split("=", 1) for entry in server["Config"]["Env"])
        assert all(environment.get(key) == value for key, value in SWITCHES.items()), environment
        assert self.sql("SELECT (SELECT count(*) FROM gym_sync_adoptions)=2 AND (SELECT count(*) FROM journal_sync_adoptions)=2;").strip() == b"t"

    def audits(self):
        for product in ("gym", "journal"):
            self.compose("exec", "-T", "server", "windmill_" + product + "_backfill", "--audit-current")

    def engine_writes(self):
        for index in range(2):
            self.request("PUT", f"/v1/gym/notes/after_adoption_{index}", index, {"body": "Engine write", "title": "After"})
            self.request("PUT", "/v1/journal/page/2026-01-03", index, {"body": "Engine write", "stamp": "102:0:e2e"})
        self.audits()

    def refusal(self, gym, journal):
        rows, runtime, files = self.sql(ROWS), self.runtime(), self.live_files()
        self.candidate({**self.values, "GYM_ENGINE_WRITES": gym, "JOURNAL_ENGINE_WRITES": journal},
                       (self.work / "Caddyfile").read_bytes() + b"\n# refused candidate\n")
        result = self.remote("deploy-production.sh")
        assert result.returncode != 0 and b"requires both" in result.stdout + result.stderr, result.stdout.decode()
        assert self.live_files() == files and self.runtime() == runtime, "refused deploy promoted files or changed containers"
        assert self.sql(ROWS) == rows, "refused deploy changed rows"

    def caddy_change(self):
        old_id = self.compose("ps", "-q", "caddy").stdout
        content = (self.work / "Caddyfile").read_bytes()
        assert content.count(b'X-Frame-Options "DENY"') == 1
        changed = content.replace(b'X-Frame-Options "DENY"', b'X-Frame-Options "SAMEORIGIN"')
        self.candidate(caddy=changed)
        result = self.remote("deploy-production.sh")
        assert result.returncode == 0, (result.stdout + result.stderr).decode()
        assert self.compose("ps", "-q", "caddy").stdout != old_id, "content change did not recreate Caddy"
        assert self.compose("exec", "-T", "caddy", "cat", "/etc/caddy/Caddyfile").stdout == changed
        expected = self.compose("exec", "-T", "caddy", "caddy", "adapt", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile").stdout
        active = self.compose("exec", "-T", "caddy", "wget", "-qO-", "http://127.0.0.1:2019/config/").stdout
        assert json.loads(expected) == json.loads(active), "Caddy admin config differs from intended file"
        self.request("GET", "/v1/gallery")
        assert {key.lower(): value for key, value in self.last_headers.items()}["x-frame-options"] == "SAMEORIGIN"

    def caddy_interrupted_retry(self):
        old_id = self.compose("ps", "-q", "caddy").stdout
        content = (self.work / "Caddyfile").read_bytes()
        assert content.count(b'X-Frame-Options "SAMEORIGIN"') == 1
        changed = content.replace(b'X-Frame-Options "SAMEORIGIN"', b'X-Frame-Options "DENY"')
        self.candidate(caddy=changed)
        marker = self.directory / "kill-deploy-after-promotion"
        marker.touch()
        result = self.remote("deploy-production.sh", extra={"WM_E2E_KILL_DEPLOY_AFTER_PROMOTION": str(marker)})
        assert result.returncode != 0 and Path(str(marker) + ".fired").exists(), "deploy was not interrupted after promotion"
        assert (self.work / "Caddyfile").read_bytes() == changed, "interruption preceded promotion"
        assert self.compose("ps", "-q", "caddy").stdout == old_id, "interruption followed recreation"
        # Linux keeps serving the replaced inode; Docker Desktop's file sharing shows it as missing.
        mounted = self.compose("exec", "-T", "caddy", "cat", "/etc/caddy/Caddyfile", okay=False)
        assert mounted.returncode != 0 or mounted.stdout == content, "old mount already served the promoted file"
        self.candidate(caddy=changed)
        result = self.remote("deploy-production.sh")
        assert result.returncode == 0 and b"PASS deployed" in result.stdout, (result.stdout + result.stderr).decode()
        assert self.compose("ps", "-q", "caddy").stdout != old_id, "same-candidate retry did not recreate Caddy"
        assert self.compose("exec", "-T", "caddy", "cat", "/etc/caddy/Caddyfile").stdout == changed
        expected = self.compose("exec", "-T", "caddy", "caddy", "adapt", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile").stdout
        active = self.compose("exec", "-T", "caddy", "wget", "-qO-", "http://127.0.0.1:2019/config/").stdout
        assert json.loads(expected) == json.loads(active), "retried Caddy admin config differs from intended file"
        self.request("GET", "/v1/gallery")
        assert {key.lower(): value for key, value in self.last_headers.items()}["x-frame-options"] == "DENY"

    def dry_checks(self):
        def context():
            rules = (BACKEND / ".dockerignore").read_text().splitlines()
            def included(path):
                allowed = True
                ancestors = [str(parent) for parent in Path(path).parents if str(parent) != "."] + [path]
                for rule in rules:
                    if not rule or rule.startswith("#"):
                        continue
                    negative = rule.startswith("!")
                    pattern = rule.lstrip("!").rstrip("/")
                    if any(fnmatch.fnmatchcase(ancestor, pattern) for ancestor in ancestors):
                        allowed = negative
                return allowed
            for path in ("deploy/Caddyfile", "deploy/docker-compose.yml", "deploy/deploy-production.sh",
                         "deploy/gym-migration/rehearse.py", "deploy/gym-migration/schema-compatibility.sh",
                         "deploy/gym-migration/cutover-production.sh"):
                assert included(path) and (BACKEND / path).is_file(), "missing Docker input " + path
            for path in ("deploy/README.md", "deploy/gym-migration/rehearse_local.py",
                         "deploy/gym-migration/__pycache__/rehearse.pyc", ".env"):
                assert not included(path), "unexpected Docker input " + path
            self.run(["git", "-C", ROOT, "cat-file", "-e", "origin/main:backend/Dockerfile"])
        self.check("dry-run Docker build inputs and origin/main", context)
        def layout():
            compose = (self.work / "docker-compose.yml").read_text()
            assert re.findall(r"^  ([a-z_]+):$", compose, re.M) == ["db", "migrate", "server", "embedder", "caddy", "pgdata", "caddy_data", "caddy_config"]
            assert '      - "127.0.0.1::80"' in compose and '      - "443:443"' not in compose
            assert compose.count("    pull_policy: never") == 5
            assert './Caddyfile:/etc/caddy/Caddyfile:ro' in compose
            assert '      GYM_ENGINE_WRITES: ${GYM_ENGINE_WRITES:-0}' in compose
            assert '      JOURNAL_ENGINE_WRITES: ${JOURNAL_ENGINE_WRITES:-0}' in compose
            assert all(key not in self.environment for key in re.findall(r"\$\{([A-Z][A-Z_0-9]*)", compose))
            assert all(f"{key}={value}\n" in (self.work / ".env").read_text()
                       for key, value in self.values.items())
            self.run(["bash", "-n"], input=REMOTE.encode())
            for script in ("deploy-production.sh", "products-cutover.sh"):
                self.run(["bash", "-n", self.work / script])
            probe = self.work / "remote-probe.sh"
            probe.write_text('set -euo pipefail\n[[ "$1" == "$PWD" ]]\n'
                             'if read -r unexpected; then exit 1; fi\nprintf "remote-probe-ok\\n"\n')
            result = self.remote(probe.name)
            assert result.returncode == 0 and result.stdout == b"remote-probe-ok\n", "remote wrapper lost its path or stdin isolation"
        self.check("dry-run production layout and remote stdin syntax", layout)
        fake = self.directory / "fake-docker"
        fake.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n')
        fake.chmod(0o755)
        marker = self.directory / "inject"
        marker.touch()
        environment = {**self.environment, "WM_E2E_REAL_DOCKER": str(fake), "WM_E2E_FAIL_PREPARE": str(marker)}
        proxy = self.directory / "bin/docker"
        def injector():
            self.write_env(".env", {**self.values, **SWITCHES})
            result = self.run([proxy, "compose", "config", "-q"], env=environment, okay=False)
            assert result.returncode == 79 and Path(str(marker) + ".fired").exists()
            assert self.run([proxy, "compose", "config", "-q"], env=environment).stdout == b"compose\nconfig\n-q\n"
            assert self.run([proxy, "inspect", "unchanged"], env=environment).stdout == b"inspect\nunchanged\n"
        self.check("dry-run one-shot failure injection and Docker forwarding", injector)
        def interrupted_deploy():
            marker = self.directory / "kill-after-promotion"
            marker.touch()
            probe = self.work / "interrupted-deploy-probe.sh"
            probe.write_text('set -euo pipefail\ndocker compose up -d --pull never\nprintf "unexpected completion\\n"\n')
            environment = {"WM_E2E_REAL_DOCKER": str(fake), "WM_E2E_KILL_DEPLOY_AFTER_PROMOTION": str(marker)}
            result = self.remote(probe.name, extra=environment)
            assert result.returncode != 0 and Path(str(marker) + ".fired").exists(), "promotion interruption did not kill the deploy shell"
            assert b"unexpected completion" not in result.stdout
            assert self.run([proxy, "compose", "up", "-d", "--pull", "never"],
                            env={**self.environment, **environment}).stdout == b"compose\nup\n-d\n--pull\nnever\n"
        self.check("dry-run one-shot SIGKILL after promotion and Docker forwarding", interrupted_deploy)

    def cleanup(self):
        if self.dry_run or not self.docker:
            return
        failures = []
        def clean(arguments):
            try:
                result = self.run([self.docker, *arguments], okay=False, timeout=180)
                if result.returncode:
                    failures.append((arguments, result.stderr.decode(errors="replace")))
            except Exception as error:
                failures.append((arguments, str(error)))
        # A killed --rm runner may remain; remove it only on this harness's network.
        runner = self.run([self.docker, "inspect", "windmill-products-cutover"], okay=False)
        if runner.returncode == 0:
            networks = json.loads(runner.stdout)[0]["NetworkSettings"]["Networks"]
            if self.identifier + "_default" in networks:
                clean(["rm", "-f", "windmill-products-cutover"])
        clean(["compose", "down", "--volumes", "--remove-orphans", "--timeout", "10"])
        if self.builder_created:
            clean(["buildx", "rm", "--force", self.builder])
        # If down failed, remove any stopped containers and resources by our unique project label.
        for kind in ("container", "volume", "network"):
            listing = "-aq" if kind == "container" else "-q"
            remaining = self.run([self.docker, kind, "ls", listing, "--filter",
                                  "label=com.docker.compose.project=" + self.identifier]).stdout.decode().split()
            if remaining:
                clean([kind, "rm", *(["-f"] if kind == "container" else []), *remaining])
            remaining = self.run([self.docker, kind, "ls", listing, "--filter",
                                  "label=com.docker.compose.project=" + self.identifier]).stdout
            if remaining.strip():
                failures.append((kind, "owned resources remain: " + remaining.decode()))
        for image in self.created_images + self.pulled_images:
            if self.run([self.docker, "image", "inspect", image], okay=False).returncode == 0:
                if image in self.created_images:
                    # Interrupted network-none image checks have no Compose project label.
                    containers = self.run([self.docker, "ps", "-aq", "--filter", "ancestor=" + image]).stdout.decode().split()
                    if containers:
                        clean(["rm", "-f", *containers])
                clean(["image", "rm", image])
        if failures:
            raise AssertionError("cleanup incomplete: " + repr(failures))
        print("PASS cleanup containers, volumes, networks, builder and images", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Real Docker production cutover regression")
    parser.add_argument("--dry-run", action="store_true", help="validate offline; no Docker required")
    args = parser.parse_args()
    def interrupted(signum, _frame):
        raise RuntimeError("interrupted by signal " + str(signum))
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    with tempfile.TemporaryDirectory(prefix="wm-cutover-compose-e2e-") as temporary:
        os.chmod(temporary, 0o700)
        harness = Harness(Path(temporary), args.dry_run)
        failed = False
        try:
            if args.dry_run:
                harness.dry_checks()
            else:
                harness.check("build runtime images from tree and origin/main", harness.build)
                harness.check("old image: two accounts seeded through gym and journal REST", harness.seed)
                harness.check("compatible deployment preserves old REST reads", harness.upgrade)
                harness.check("pre-start failure restores exact rows, sequences and old running config", harness.rollback)
                harness.check("cutover enables both writers and preserves REST reads", harness.success)
                harness.check("both adoption audits pass", harness.audits)
                harness.check("SYNC_ENABLED=0 keeps /v1/sync at 404", lambda: harness.request("GET", "/v1/sync", expected=404))
                harness.check("post-cutover REST writes maintain engine digests", harness.engine_writes)
                for gym, journal in (("0", "0"), ("0", "1"), ("1", "0")):
                    harness.check(f"later deploy refuses gym={gym} journal={journal} before promotion",
                                  lambda gym=gym, journal=journal: harness.refusal(gym, journal))
                harness.check("Caddyfile change reaches mounted file, active config and HTTP response", harness.caddy_change)
                harness.check("same-candidate deploy heals SIGKILL after Caddyfile promotion", harness.caddy_interrupted_retry)
        except Exception as error:
            failed = True
            message = str(error) or type(error).__name__
            print("FAIL " + harness.check_name + ": " + message.splitlines()[0], flush=True)
            print(message, file=sys.stderr)
            # Cutover's private logs explain internal failures without changing the script.
            for log in harness.work.glob("migration-evidence/*/control.log"):
                print(log.read_text(errors="replace")[-6000:], file=sys.stderr)
        finally:
            try:
                harness.cleanup()
            except Exception as error:
                failed = True
                print("FAIL cleanup: " + " ".join(str(error).splitlines()), flush=True)
        return int(failed)


if __name__ == "__main__":
    sys.exit(main())
