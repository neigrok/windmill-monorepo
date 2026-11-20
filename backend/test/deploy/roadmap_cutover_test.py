#!/usr/bin/env python3
# Roadmap's cutover onto the sync engine: the Roadmap cutover workflow's cutover job run step by step as Actions runs
# it, over its host stages (deploy/roadmap-cutover.sh), with ssh, rsync and the public site stood in. The host is a
# model here; with WM_CUTOVER_TOOL, WM_CUTOVER_SERVER and a maintenance DATABASE_URL it is a local stack instead: a
# Postgres database seeded with roadmap's adoption fixture, the built windmill_roadmap_adopt and windmill_server, and
# the production Caddyfile in Caddy's image (needs Docker).
import hashlib
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
import textwrap
import time
import unittest


REPOSITORY = Path(__file__).resolve().parents[3]
WORKFLOW = REPOSITORY / ".github/workflows/roadmap-cutover.yml"
IMAGE = "c" * 40
PINNED = "sha256:" + "a" * 64
RUN = "4242-1"
EXPECTED_OWNERLESS = "t_c000000000000001\nt_d000000000000001\n"
DEMO = "t_9e407a96b5330ebe"
STAGES = ["unfold", "read-models-before", "before", "adopt", "demo", "after", "read-models", "digests"]
CANARIES = ["PRIVATE_SSH_KEY_CANARY", "PRIVATE_TOOL_CANARY", "PRIVATE_RECORD_CANARY", "PRIVATE_DUMP_CANARY",
            "PRIVATE_ROW_CANARY", "t_c000000000000001", "t_d000000000000001", "t_a000000000000001"]
CUTOVER_STEPS = [
    ("uses: actions/checkout@v5", None), ("uses: actions/download-artifact@v4", None), ("Reach the host", None),
    ("Check the host is ready", "check"), ("Pause the site", "pause"), ("Stop the server", "stop"),
    ("Back up the database", "backup"), ("Adopt roadmap's rows and check every digest", "adopt"),
    ("Seal the private record", "seal"), ("Start the server on the sync engine", "start"),
    ("Promote the web whose room reads the replica", "web"), ("Walk the stack", "smoke"), ("Lift the pause", "lift"),
    ("Restore the backup", None), ("Return the site as it was", None), ("Keep the sealed record for a day", None),
    ("Forget the deploy key", None)]


# The subset of YAML the workflow is written in: mappings, lists of mappings, plain and quoted scalars, `|` blocks.
def indentation(line):
    return len(line) - len(line.lstrip(" "))


def scalar(value):
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    if value.startswith('"') and value.endswith('"'):
        return value[1:-1]
    return value


def nested(lines, index, level):
    body = []
    while index < len(lines) and (not lines[index].strip() or indentation(lines[index]) > level):
        body.append(lines[index])
        index += 1
    return body, index


def mapping(lines):
    meaningful = [line for line in lines if line.strip() and not line.lstrip().startswith("#")]
    level = indentation(meaningful[0])
    result, index = {}, 0
    while index < len(lines):
        line = lines[index]
        index += 1
        if not line.strip() or line.lstrip().startswith("#") or indentation(line) != level:
            continue
        key, _, value = line.strip().partition(":")
        value = value.strip()
        if value == "|":
            body, index = nested(lines, index, level)
            result[key] = textwrap.dedent("\n".join(body)).strip("\n") + "\n"
        elif value == "":
            body, index = nested(lines, index, level)
            first = next((entry for entry in body if entry.strip() and not entry.lstrip().startswith("#")), None)
            result[key] = "" if first is None else listing(body) if first.lstrip().startswith("- ") else mapping(body)
        else:
            result[key] = scalar(value)
    return result


def listing(lines):
    level = indentation(next(line for line in lines if line.lstrip().startswith("- ")))
    items = []
    for line in lines:
        if indentation(line) == level and line.lstrip().startswith("- "):
            items.append([" " * (level + 2) + line.lstrip()[2:]])
        elif items and (not line.strip() or indentation(line) > level):
            items[-1].append(line)
    return [mapping(item) if ":" in item[0] else scalar(item[0].strip()) for item in items]


def workflow():
    return mapping(WORKFLOW.read_text().splitlines())


def step_label(step):
    return step.get("name") or "uses: " + step["uses"]


def executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


def shim(path, mode):
    executable(path, "#!" + sys.executable + "\nimport runpy, sys\nsys.argv = [" + repr(str(Path(__file__).resolve())) +
               ", " + repr(mode) + "] + sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name='__main__')\n")


# The cutover job as Actions runs it: each step's condition decided by the job's status and the steps' outcomes so far,
# `run` steps under bash with the job's and the step's environment, and the three actions it uses stood in.
class Job:
    def __init__(self, definition, context, workspace, environment, artifact, artifacts):
        self.definition, self.context, self.workspace = definition, context, workspace
        self.environment, self.artifact, self.artifacts = environment, artifact, artifacts

    def expand(self, text):
        return re.sub(r"\$\{\{\s*(.*?)\s*\}\}", lambda match: self.context[match.group(1)], text)

    def decides(self, condition, failed, cancelled, outcomes):
        if condition is None:
            return not failed and not cancelled
        expression = re.sub(r"steps\.([a-z]+)\.outcome", lambda match: repr(outcomes.get(match.group(1), "skipped")), condition)
        for written, meant in (("always()", "True"), ("failure()", "failed"), ("cancelled()", "cancelled"),
                               ("&&", " and "), ("||", " or ")):
            expression = expression.replace(written, meant)
        return eval(expression, {}, {"failed": failed, "cancelled": cancelled})

    def run(self, cancel_at=None):
        failed = cancelled = False
        outcomes, log = {}, []
        for step in self.definition["steps"]:
            label = step_label(step)
            if not self.decides(step.get("if"), failed, cancelled, outcomes):
                outcomes[step.get("id", label)] = "skipped"
                continue
            if step.get("id") is not None and step.get("id") == cancel_at:
                outcomes[step["id"]] = "cancelled"
                cancelled = True
                continue
            code, output = self.execute(step)
            log.append((label, code, output))
            outcome = "success" if code == 0 else "failure"
            outcomes[step.get("id", label)] = outcome
            if outcome == "failure" and step.get("continue-on-error") != "true":
                failed = True
        return outcomes, log

    def execute(self, step):
        uses = step.get("uses", "")
        if uses.startswith("actions/checkout@"):
            return 0, ""
        if uses.startswith("actions/download-artifact@"):
            shutil.copytree(self.artifact, self.expand(step["with"]["path"]))
            return 0, ""
        if uses.startswith("actions/upload-artifact@"):
            shutil.copytree(self.expand(step["with"]["path"]), self.artifacts / self.expand(step["with"]["name"]))
            return 0, ""
        environment = {**self.environment,
                       **{key: self.expand(value) for key, value in self.definition.get("env", {}).items()},
                       **{key: self.expand(value) for key, value in step.get("env", {}).items()}}
        directory = self.expand(step.get("working-directory", str(self.workspace)))
        result = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step["run"]], cwd=directory,
                                env=environment, capture_output=True, text=True, timeout=600)
        return result.returncode, result.stdout + result.stderr


# A host and a runner around a stand-in of the VPS, the job's workspace holding its own certificate and the deploy files.
class Stage:
    def __init__(self, test, host_shim):
        directory = tempfile.TemporaryDirectory(prefix="roadmap-cutover-")
        test.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.home = self.root / "host"
        self.windmill = self.home / "windmill"
        for folder in ("host/windmill/web", "host/windmill/maintenance", "host/bin", "runner/bin", "runner/temp",
                       "workspace/.github/ops", "workspace/backend/deploy", "artifact/dist", "artifacts", "owner"):
            (self.root / folder).mkdir(parents=True)
        (self.windmill / ".env").write_text(f"IMAGE_TAG={IMAGE}\nPOSTGRES_PASSWORD=PRIVATE_SSH_KEY_CANARY\nSERVER_IMAGE={PINNED}\n")
        (self.windmill / "roadmap-engine.env").write_text("")
        shutil.copyfile(REPOSITORY / "backend/deploy/docker-compose.yml", self.windmill / "docker-compose.yml")
        (self.windmill / "web/index.html").write_text("<!doctype html><html><head><title>Windmill</title></head><body>old</body></html>\n")
        self.workspace = self.root / "workspace"
        for name in ("roadmap-cutover.sh", "sync_compatibility.py"):
            shutil.copyfile(REPOSITORY / "backend/deploy" / name, self.workspace / "backend/deploy" / name)
        self.owner_key = self.root / "owner/key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=roadmap-cutover-test",
                        "-keyout", str(self.owner_key), "-out", str(self.workspace / ".github/ops/inventory-recipient.pem")],
                       check=True, capture_output=True)
        (self.root / "artifact/dist/index.html").write_text(
            "<!doctype html><html><head><title>Windmill</title></head><body>replica room</body></html>\n")
        (self.root / "artifact/dist/assets.js").write_text("export const room = 'replica';\n")
        sys.path.insert(0, str(REPOSITORY / "backend/deploy"))
        from sync_compatibility import metadata
        (self.root / "artifact/web-sync-compatibility.json").write_text(json.dumps(metadata(REPOSITORY / "packages/api-contract/sync")))
        shim(self.root / "host/bin/docker", host_shim)
        for name in ("ssh", "rsync", "curl"):
            shim(self.root / "runner/bin" / name, "--" + name + "-shim")
        self.calls = self.root / "ssh-calls"
        self.environment = {**os.environ, "PATH": str(self.root / "runner/bin") + os.pathsep + os.environ["PATH"],
                            "RUNNER_TEMP": str(self.root / "runner/temp"), "GITHUB_WORKSPACE": str(self.workspace),
                            "GITHUB_SHA": "d" * 40, "WM_HOST_HOME": str(self.home), "WM_HOST_BIN": str(self.root / "host/bin"),
                            "WM_SSH_CALLS": str(self.calls), "WM_DOCKER": shutil.which("docker") or "docker",
                            "WM_CURL": shutil.which("curl") or "curl"}
        self.context = {"secrets.SSH_KEY": "PRIVATE_SSH_KEY_CANARY", "secrets.SSH_HOST": "vps.invalid",
                        "secrets.SSH_USER": "deploy", "secrets.SSH_PORT": "", "github.run_id": RUN.split("-")[0],
                        "github.run_attempt": RUN.split("-")[1], "inputs.image_tag": IMAGE, "vars.DOMAIN_APP": "app.localhost",
                        "secrets.ROADMAP_ADOPTION_EXPECTED_OWNERLESS": EXPECTED_OWNERLESS,
                        "runner.temp": str(self.root / "runner/temp")}

    def job(self):
        return Job(workflow()["jobs"]["cutover"], self.context, self.workspace, self.environment, self.root / "artifact",
                   self.root / "artifacts")

    def host_stages(self):
        return [re.search(r"roadmap-cutover\.sh (\w+)", line).group(1) for line in self.calls.read_text().splitlines()
                if "roadmap-cutover.sh " in line and "cat >" not in line]

    def sealed(self):
        folder = self.root / f"artifacts/roadmap-cutover-record-{RUN}"
        key = subprocess.run(["openssl", "smime", "-decrypt", "-inform", "PEM", "-inkey", str(self.owner_key),
                              "-in", str(folder / "key.pem")], check=True, capture_output=True, text=True).stdout
        plain = subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-pass", "env:ROADMAP_CUTOVER_KEY",
                                "-in", str(folder / "record.tar.enc")], env={**os.environ, "ROADMAP_CUTOVER_KEY": key},
                               check=True, capture_output=True).stdout
        archive = self.root / "record.tar"
        archive.write_bytes(plain)
        with tarfile.open(archive) as record:
            files = {Path(member.name).name: record.extractfile(member).read().decode()
                     for member in record.getmembers() if member.isfile()}
        archive.unlink()
        return sorted(path.name for path in folder.iterdir()), files

    def assert_nothing_private(self, test, log, private=CANARIES):
        printed = "".join(output for _, _, output in log)
        for canary in private:
            test.assertNotIn(canary, printed)
        for folder in ("runner", "workspace", "artifacts"):
            for path in (self.root / folder).rglob("*"):
                if path.is_file() and path.name != "deploy_key":
                    for canary in private:
                        test.assertNotIn(canary.encode(), path.read_bytes(), path)


def printed(log, label):
    return next(output for name, _, output in log if name == label)


class WorkflowShapeTest(unittest.TestCase):
    def test_it_runs_by_hand_confirms_the_backup_and_takes_the_deploy_lock_for_the_cutover_job_alone(self):
        definition = workflow()
        self.assertEqual(definition["on"], {"workflow_dispatch": {"inputs": {
            "image_tag": {"description": "Full main commit SHA the live server runs; its windmill_roadmap_adopt moves the rows",
                          "required": "true", "type": "string"},
            "backup": {"description": 'Type "back up, restore on failure": the run backs up the database once the server stops, '
                                      'and restores it on any failure before the server starts on the engine',
                       "required": "true", "type": "string"}}}})
        self.assertEqual(definition["permissions"], {"contents": "read", "actions": "read"})
        self.assertNotIn("concurrency", definition)
        self.assertEqual({name: job.get("needs") for name, job in definition["jobs"].items()},
                         {"web": None, "guard": "web", "cutover": "guard", "walk": "cutover"})
        self.assertEqual({name: job.get("concurrency") for name, job in definition["jobs"].items()},
                         {"web": None, "guard": None, "cutover": {"group": "deploy-vps", "cancel-in-progress": "false"}, "walk": None})
        confirm = definition["jobs"]["web"]["steps"][0]
        for confirmation, image, outcome in (("back up, restore on failure", IMAGE, (0, "")),
                                             ("yes", IMAGE, (1, 'Refusing the cutover: the backup input must read "back up, restore on failure".\n')),
                                             ("back up, restore on failure", "main", (1, "Refusing the cutover: image_tag must be a full commit SHA.\n"))):
            with self.subTest(confirmation=confirmation, image=image):
                result = subprocess.run(["bash", "-eo", "pipefail", "-c", confirm["run"]], capture_output=True, text=True,
                                        env={**os.environ, "CONFIRMATION": confirmation, "IMAGE_TAG": image})
                self.assertEqual((result.returncode, result.stdout + result.stderr), outcome)

    def test_the_stages_run_in_their_order_each_on_its_own_host_stage(self):
        steps = workflow()["jobs"]["cutover"]["steps"]
        self.assertEqual([(step_label(step), step.get("id")) for step in steps], CUTOVER_STEPS)
        for step in steps:
            if step.get("id") in ("check", "pause", "stop", "backup", "adopt", "start", "smoke", "lift"):
                self.assertIn(f"bash roadmap-cutover.sh {step['id']} $RUN", step["run"])
        self.assertEqual({step_label(step): step.get("if") for step in steps if step.get("if")}, {
            "Seal the private record": "always() && steps.adopt.outcome != 'skipped'",
            "Restore the backup": "(failure() || cancelled()) && steps.backup.outcome == 'success' && steps.start.outcome == 'skipped'",
            "Return the site as it was": "(failure() || cancelled()) && steps.pause.outcome != 'skipped' && steps.backup.outcome != 'success'",
            "Keep the sealed record for a day": "always() && steps.seal.outcome == 'success'",
            "Forget the deploy key": "always()"})
        self.assertEqual([step_label(step) for step in steps if step.get("continue-on-error")], ["Seal the private record"])

    def test_the_cutover_builds_the_web_as_web_deploy_does_with_its_room_reading_the_replica(self):
        deploy = mapping((REPOSITORY / ".github/workflows/web.yml").read_text().splitlines())["jobs"]["build-and-deploy"]["steps"]
        cutover = workflow()["jobs"]["web"]["steps"]
        built = lambda steps: next(step for step in steps if step.get("name") == "Build")
        self.assertEqual({**built(deploy)["env"], "VITE_ROADMAP_REPLICA_ROOM": "on"}, built(cutover)["env"])
        self.assertEqual(built(deploy)["env"]["VITE_ROADMAP_REPLICA_ROOM"], "${{ steps.roadmap.outputs.room || 'off' }}")
        shared = lambda steps: [{key: value for key, value in step.items() if key != "env"} for step in steps
                                if step.get("uses", "").startswith(("actions/setup-node", "actions/cache", "./.github"))
                                or step.get("run") == "npm ci" or step.get("name") == "Build"]
        self.assertEqual(shared(cutover), shared(deploy))
        self.assertEqual(cutover[-1]["with"], {"name": "roadmap-cutover-web-${{ github.run_id }}-${{ github.run_attempt }}",
                                               "path": "web/dist/\nweb/web-sync-compatibility.json\n", "include-hidden-files": "true",
                                               "if-no-files-found": "error", "retention-days": "14"})

    def test_the_cutover_waits_for_the_lock_only_once_no_deploy_and_no_other_cutover_holds_it_or_waits_for_it(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        bin = Path(directory.name)
        executable(bin / "gh", "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$GH_CALLS\"\n"
                               "case \" $* \" in *\" --workflow $BUSY_WORKFLOW --status $BUSY_STATUS \"*) echo 1 ;; *) echo 0 ;; esac\n")
        guard = workflow()["jobs"]["guard"]["steps"][1]["run"]
        workflows = sorted(path.name for path in (REPOSITORY / ".github/workflows").glob("*.yml") if "deploy-vps" in path.read_text())
        self.assertEqual(workflows, ["deploy.yml", "gym-backup.yml", "ops-roadmap-copy.yml", "ops-subtree-inventory.yml",
                                     "roadmap-cutover.yml", "sync-digest-resum.yml", "web.yml"])
        statuses = ["queued", "in_progress", "waiting", "requested", "pending"]
        for busy, status, outcome in ((None, None, (0, "")), ("roadmap-cutover.yml", "queued",
                                      (1, "Not now: roadmap-cutover.yml has a run queued. Dispatch the cutover again once it has finished.\n"))):
            with self.subTest(busy=busy):
                calls = bin / f"calls-{busy}"
                result = subprocess.run(["bash", "-eo", "pipefail", "-c", guard], cwd=REPOSITORY, capture_output=True, text=True,
                                        env={**os.environ, "PATH": str(bin) + os.pathsep + os.environ["PATH"], "GH_CALLS": str(calls),
                                             "GITHUB_REPOSITORY": "owner/repository", "GITHUB_RUN_ID": "4242",
                                             "BUSY_WORKFLOW": busy or "", "BUSY_STATUS": status or ""})
                self.assertEqual((result.returncode, result.stdout + result.stderr), outcome)
                asked = calls.read_text().splitlines()
                self.assertTrue(all(line.endswith('[.[] | select(.event != "pull_request" and .databaseId != 4242)] | length')
                                    for line in asked))
                every = [f"{name} --status {each}" for name in workflows for each in statuses]
                self.assertEqual([line.split(" --workflow ", 1)[1].split(" --json", 1)[0] for line in asked],
                                 every if busy is None else every[:every.index(f"{busy} --status {status}") + 1])


# The VPS as roadmap-cutover.sh meets it, kept in a JSON state beside the host: the server's container, Postgres'
# databases and answers, and the tool's output.
def model_docker(arguments):
    path = Path(os.environ["WM_HOST_HOME"]) / "state.json"
    state = json.loads(path.read_text())
    state["commands"].append(arguments)
    code, output, error = model_answer(state, arguments)
    path.write_text(json.dumps(state))
    sys.stdout.write(output)
    sys.stderr.write(error)
    return code


def model_answer(state, arguments):
    server = state["server"]
    if arguments == ["compose", "ps", "-q", "server"]:
        return 0, "server-container\n" if server["running"] else "", ""
    if arguments == ["inspect", "--format", "{{.Image}}", "server-container"]:
        return 0, state["imageId"] + "\n", ""
    if arguments[:2] == ["rm", "-f"]:
        return 0, "", ""
    if arguments in (["compose", "stop", "server"], ["compose", "start", "server"],
                     ["compose", "up", "-d", "--no-deps", "--pull", "never", "server"]):
        server["running"] = arguments[1] != "stop"
        if arguments[1] == "up":
            server["env"] = dict(line.split("=", 1) for line in Path("roadmap-engine.env").read_text().splitlines() if line)
        return 0, "", ""
    if arguments == ["compose", "run", "--rm", "--no-deps", "-T", "migrate"]:
        return 0, "", ""
    if arguments[:5] == ["compose", "run", "--rm", "--no-deps", "-T"]:
        mounts = dict(tuple(reversed(argument.split(":")[:2])) for argument in arguments
                      if argument.startswith("/") and ":/adoption/" in argument)
        record = Path(mounts["/adoption/record"])
        for name, text in state["tool"]["record"].items():
            (record / name).write_text(text)
        state["tool"]["expected"] = Path(mounts["/adoption/expected-ownerless"]).read_text()
        state["tool"]["arguments"] = arguments
        return state["tool"]["exit"], state["tool"]["stdout"], state["tool"]["stderr"]
    exec_in = arguments[3] if arguments[:3] == ["compose", "exec", "-T"] else None
    command = arguments[4:]
    if exec_in == "caddy":
        return (0 if state["pauseMounted"] else 1), "", ""
    if exec_in == "server" and command[0] == "sh":
        if "command -v windmill_roadmap_adopt" in command[2]:
            return (0, "/usr/local/bin/windmill_roadmap_adopt\n", "") if state["toolCarried"] else (1, "", "")
        return (0 if server["running"] and server["env"].get("ROADMAP_ENGINE_ENABLED") == "1" else 1), "", ""
    if exec_in == "server" and command[0] == "curl":
        if not server["running"]:
            return 7, "", "curl: (7) Failed to connect\n"
        method = command[command.index("-X") + 1] if "-X" in command else "GET"
        route = command[-1].split("127.0.0.1:8080", 1)[1]
        if route == "/v1/sync/hello":
            return 0, json.dumps({"schema": 13, "minSchema": 11, "epoch": "e", "serverTime": 1}) + "\n200", ""
        status, body = state["answers"].get(f"{method} {route}", [200, {}])
        return 0, json.dumps(body) + "\n" + str(status), ""
    if exec_in == "db":
        return model_database(state, command)
    raise AssertionError("unmodeled docker command: " + repr(arguments))


def model_database(state, command):
    if command[0] == "psql":
        sql = command[-1]
        if "pg_database_size" in sql:
            return 0, str(state["databaseBytes"]) + "\n", ""
        if "group by 1" in sql:
            return 0, "psql 1\n", ""
        if "select count(*) from pg_stat_activity" in sql:
            return 0, str(state["otherSessions"].pop(0) if state["otherSessions"] else 0) + "\n", ""
        if "pg_terminate_backend" in sql:
            return 0, "0\n", ""
        if sql == "drop database if exists windmill_restore":
            state["databases"] = [name for name in state["databases"] if name != "windmill_restore"]
            return 0, "", ""
        if sql.startswith("alter database windmill rename to "):
            moved = sql.split("rename to ", 1)[1].split(";", 1)[0]
            state["databases"] = sorted({*state["databases"]} - {"windmill", "windmill_restore"} | {moved, "windmill"})
            state["restored"] = True
            return 0, "", ""
    if command[0] == "df":
        return 0, "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 100000000 1 99999999 1% /var/lib/postgresql/data\n", ""
    if command[0] == "pg_dump":
        return 0, "PGDMP PRIVATE_DUMP_CANARY\n", ""
    if command[0] == "createdb":
        state["databases"].append(command[-1])
        return 0, "", ""
    if command[0] == "pg_restore":
        dump = sys.stdin.read()
        if not dump.startswith("PGDMP"):
            return 1, "", "pg_restore: error: input file does not appear to be a valid archive\n"
        if command[1] == "--list":
            return 0, ";\n;     dbname: windmill\n;\n3; 0 0 TABLE DATA public trees windmill PRIVATE_ROW_CANARY\n", ""
        if state.get("restoreFails"):
            return 1, "", "pg_restore: error: COPY failed for table \"trees\": PRIVATE_ROW_CANARY\n"
        state["restoredFrom"] = dump
        return 0, "", ""
    raise AssertionError("unmodeled database command: " + repr(command))


def stage_line(stage, verdict, counts):
    return json.dumps({"stage": stage, "verdict": verdict, "ms": 12, "counts": counts}) + "\n"


PASSED = "".join(stage_line(stage, verdict, {"roadmaps": {"adopted": 13}})
                 for stage, verdict in zip(STAGES, ["unfolded", "asked", "ready", "adopted", "present", "same", "same", "summed"]))
STOPPED = (stage_line("unfold", "unfolded", {"roadmaps": {"lastChangeKept": 1}}) + stage_line("read-models-before", "asked", {"answers": 72}) +
           stage_line("before", "stops", {"stop": {"unknownStepStatus": 1}}))


class CutoverAgainstAModeledHostTest(unittest.TestCase):
    def setUp(self):
        self.stage = Stage(self, "--model-docker-shim")
        executable(self.stage.root / "host/bin/sleep", "#!/bin/sh\nexit 0\n")
        self.answers = {"GET /v1/socket": [410, {"error": "update", "code": "client-update-required"}],
                        "POST /v1/trees": [410, {"error": "update", "code": "client-update-required"}]}
        self.model(tool={"stdout": PASSED, "stderr": "PRIVATE_TOOL_CANARY on stderr\n", "exit": 0,
                         "record": {"before.jsonl": '{"roadmap":"t_a000000000000001","title":"PRIVATE_RECORD_CANARY"}\n'}})

    def model(self, **changes):
        path = self.stage.home / "state.json"
        state = json.loads(path.read_text()) if path.exists() else {
            "commands": [], "server": {"running": True, "env": {}}, "imageId": PINNED, "toolCarried": True, "pauseMounted": True,
            "databaseBytes": 50 * 1048576, "otherSessions": [], "databases": ["windmill"], "answers": self.answers}
        state.update(changes)
        path.write_text(json.dumps(state))
        return state

    def files(self):
        return {str(path.relative_to(self.stage.windmill)): path.read_bytes() for path in self.stage.windmill.rglob("*") if path.is_file()}

    def test_a_cutover_pauses_moves_starts_the_engine_promotes_the_web_and_lifts_printing_only_counts_and_verdicts(self):
        outcomes, log = self.stage.job().run()
        self.assertEqual({step: outcome for step, outcome in outcomes.items() if outcome != "success"},
                         {"Restore the backup": "skipped", "Return the site as it was": "skipped"}, log)
        self.assertEqual(self.stage.host_stages(), ["check", "pause", "stop", "backup", "adopt", "record", "forget", "start",
                                                    "smoke", "lift"])
        self.assertRegex(printed(log, "Check the host is ready"),
                         r"\Adisk: the database 50 MB; free \d+ MB beside the backups and 97656 MB beside the database; 1174 MB needed\n"
                         f"PASS check: the server runs {IMAGE} and carries windmill_roadmap_adopt; roadmap is off the engine; "
                         r"the pause is mounted\n\Z")
        self.assertEqual(printed(log, "Pause the site"), "PASS pause: maintenance/on is set\n"
                                                         "PASS site: https://app.localhost answers 503 on its page and its API\n")
        self.assertEqual(printed(log, "Stop the server"), "PASS stop: the server is stopped and no client is on the database\n")
        backup = next(name for name in self.files() if name.startswith("backups/") and name.endswith(".dump"))
        self.assertRegex(backup, rf"^backups/roadmap-cutover-{RUN}-\d{{8}}T\d{{6}}Z\.dump$")
        digest = hashlib.sha256(b"PGDMP PRIVATE_DUMP_CANARY\n").hexdigest()
        self.assertEqual(printed(log, "Back up the database"),
                         f"PASS backup verified: {backup}, 26 bytes\n{digest}  {backup}\n")
        self.assertEqual(printed(log, "Adopt roadmap's rows and check every digest"),
                         "Ownerless roadmaps the move expects beside the public demo: 2\n" +
                         "".join(json.dumps(json.loads(line), sort_keys=True, separators=(",", ":")) + "\n" for line in PASSED.splitlines()) +
                         "PASS adopt: every stage passed\n")
        self.assertEqual(printed(log, "Start the server on the sync engine"),
                         "PASS start: the server runs its pinned image with ROADMAP_ENGINE_ENABLED=1; hello says schema 13, minimum 11\n")
        self.assertEqual(printed(log, "Promote the web whose room reads the replica"),
                         "PASS web deployment: live backend accepts the candidate sync client, roadmap's room on\n"
                         f"PASS web: 2 files promoted, built from {'d' * 40} with roadmap's room on\n")
        self.assertEqual(printed(log, "Walk the stack"), "".join(f"PASS smoke: {line}\n" for line in [
            "GET /v1/sync/hello answers 200", "GET /v1/socket answers 410 client-update-required",
            "POST /v1/trees answers 410 client-update-required", f"GET /v1/trees/{DEMO}/progress answers 200",
            f"GET /v1/trees/{DEMO}/activity answers 200", f"GET /t/{DEMO} answers 200", "GET /gallery answers 200"]))
        self.assertEqual(printed(log, "Lift the pause"), "PASS lift: maintenance/on is gone\n"
                                                         "PASS site: https://app.localhost answers 200 on its page and its API\n")
        state = self.model()
        self.assertEqual((state["server"], state["tool"]["expected"]), ({"running": True, "env": {"ROADMAP_ENGINE_ENABLED": "1"}},
                                                                         EXPECTED_OWNERLESS))
        self.assertEqual(self.stage.sealed(), (["key.pem", "record.tar.enc"], {
            "before.jsonl": '{"roadmap":"t_a000000000000001","title":"PRIVATE_RECORD_CANARY"}\n',
            "tool.stderr": "PRIVATE_TOOL_CANARY on stderr\n"}))
        files = self.files()
        self.assertEqual((files["roadmap-engine.env"], files["web/index.html"], "maintenance/on" in files),
                         (b"ROADMAP_ENGINE_ENABLED=1\n", (self.stage.root / "artifact/dist/index.html").read_bytes(), False))
        self.assertEqual(sorted(name for name in files if name.startswith("roadmap-cutover/")), [f"roadmap-cutover/{RUN}/backup"])
        self.assertFalse((self.stage.root / "runner/temp/deploy_key").exists())
        self.stage.assert_nothing_private(self, log)

    def test_only_a_stages_own_line_in_its_own_shape_reaches_the_log(self):
        lines = ["PRIVATE_TOOL_CANARY not json", json.dumps({"stage": "adopt", "verdict": "adopted", "ms": 1,
                                                             "counts": {"t_a000000000000001": 1}}),
                 json.dumps({"stage": "adopt", "verdict": "PRIVATE_TOOL_CANARY", "ms": 1, "counts": {}}),
                 json.dumps({"stage": "adopt", "verdict": "adopted", "ms": 1, "counts": {"roadmaps": {"adopted": "13"}}}),
                 json.dumps({"stage": "adopt", "verdict": "adopted", "ms": 1, "counts": {}, "roadmap": "t_a000000000000001"}),
                 json.dumps(["PRIVATE_TOOL_CANARY"]), json.dumps({"stage": "digests", "verdict": "summed", "ms": 3,
                                                                  "counts": {"scopes": {"summed": 20}}})]
        self.model(tool={"stdout": "\n".join(lines) + "\n", "stderr": "", "exit": 0, "record": {}})
        outcomes, log = self.stage.job().run()
        self.assertEqual(outcomes["adopt"], "success")
        self.assertEqual(printed(log, "Adopt roadmap's rows and check every digest"),
                         "Ownerless roadmaps the move expects beside the public demo: 2\n"
                         '{"counts":{"scopes":{"summed":20}},"ms":3,"stage":"digests","verdict":"summed"}\n'
                         "WITHHELD adopt: 6 lines of the tool's output were not a stage's counts\n"
                         "PASS adopt: every stage passed\n")
        self.stage.assert_nothing_private(self, log)

    def test_a_stop_seals_the_record_restores_the_backup_and_lifts_the_pause_and_nothing_after_it_runs(self):
        self.model(tool={"stdout": STOPPED, "stderr": "", "exit": 3,
                         "record": {"stops.jsonl": '{"reason":"stop.unknownStepStatus","roadmap":"t_a000000000000001"}\n'}})
        outcomes, log = self.stage.job().run()
        self.assertEqual({step: outcomes[step] for step in ("adopt", "seal", "start", "web", "smoke", "lift", "Restore the backup",
                                                             "Return the site as it was", "Keep the sealed record for a day")},
                         {"adopt": "failure", "seal": "success", "start": "skipped", "web": "skipped", "smoke": "skipped",
                          "lift": "skipped", "Restore the backup": "success", "Return the site as it was": "skipped",
                          "Keep the sealed record for a day": "success"})
        self.assertEqual(self.stage.host_stages(), ["check", "pause", "stop", "backup", "adopt", "record", "forget", "restore"])
        self.assertIn("STOP adopt: a stage did not pass, and nothing after it ran\n", printed(log, "Adopt roadmap's rows and check every digest"))
        backup = next(name for name in self.files() if name.endswith(".dump"))
        self.assertEqual(printed(log, "Restore the backup"),
                         f"PASS restore: windmill is {backup} again, its sha256 matched; the moved database is kept as windmill_cutover_4242_1\n"
                         "PASS restore: the server serves as before the cutover, roadmap off the engine, and the site is lifted\n"
                         "PASS site: https://app.localhost answers 200 on its page and its API\n")
        state = self.model()
        self.assertEqual((state["databases"], state["restoredFrom"], state["server"]),
                         (["windmill", "windmill_cutover_4242_1"], "PGDMP PRIVATE_DUMP_CANARY\n", {"running": True, "env": {}}))
        restore = state["commands"][[command[:2] for command in state["commands"]].index(["rm", "-f"]):]
        self.assertEqual([command[4] if command[:3] == ["compose", "exec", "-T"] else " ".join(command[:2]) for command in restore], [
            "rm -f", "pg_restore", "psql", "createdb", "pg_restore", "psql", "psql", "compose run", "compose start", "curl"])
        self.assertEqual(self.stage.sealed()[1]["stops.jsonl"], '{"reason":"stop.unknownStepStatus","roadmap":"t_a000000000000001"}\n')
        files = self.files()
        self.assertEqual((files["roadmap-engine.env"], "maintenance/on" in files), (b"", False))
        self.stage.assert_nothing_private(self, log)

    def test_a_cutover_cancelled_while_it_adopts_seals_what_it_has_and_restores_the_backup(self):
        outcomes, log = self.stage.job().run(cancel_at="adopt")
        self.assertEqual({step: outcomes[step] for step in ("adopt", "seal", "start", "Restore the backup", "Return the site as it was")},
                         {"adopt": "cancelled", "seal": "failure", "start": "skipped", "Restore the backup": "success",
                          "Return the site as it was": "skipped"})
        self.assertIn("FAIL record: this run keeps no private record\n", printed(log, "Seal the private record"))
        self.assertEqual(self.stage.host_stages()[-2:], ["record", "restore"])
        self.assertEqual(self.model()["databases"], ["windmill", "windmill_cutover_4242_1"])

    def test_a_failure_before_the_backup_leaves_the_database_untouched_and_returns_the_site_as_it_was(self):
        for failure, stages in (({"otherSessions": [1] * 30}, ["check", "pause", "stop", "undo"]),
                                ({"pauseMounted": False}, ["check"])):
            with self.subTest(failure=failure):
                self.stage = Stage(self, "--model-docker-shim")
                executable(self.stage.root / "host/bin/sleep", "#!/bin/sh\nexit 0\n")
                self.model(tool={"stdout": PASSED, "stderr": "", "exit": 0, "record": {}}, **failure)
                outcomes, log = self.stage.job().run()
                self.assertEqual(self.stage.host_stages(), stages)
                self.assertEqual(outcomes["Restore the backup"], "skipped")
                state = self.model()
                self.assertEqual((state["databases"], state["server"]["running"], "maintenance/on" in self.files()),
                                 (["windmill"], True, False))
                self.assertFalse(any(command[:4] == ["compose", "exec", "-T", "db"] and command[4] == "pg_dump"
                                     for command in state["commands"]))
        self.assertEqual(printed(log, "Check the host is ready").splitlines()[-1], "FAIL check: Caddy does not mount the maintenance folder")

    def test_once_the_server_starts_on_the_engine_a_failure_goes_forward_only_and_keeps_the_pause(self):
        self.answers["GET /v1/socket"] = [404, {"error": "PRIVATE_ROW_CANARY"}]
        self.model(answers=self.answers)
        outcomes, log = self.stage.job().run()
        self.assertEqual({step: outcomes[step] for step in ("start", "web", "smoke", "lift", "Restore the backup", "Return the site as it was")},
                         {"start": "success", "web": "success", "smoke": "failure", "lift": "skipped", "Restore the backup": "skipped",
                          "Return the site as it was": "skipped"})
        self.assertIn("FAIL smoke: GET /v1/socket answers 404, not 410 client-update-required\n", printed(log, "Walk the stack"))
        files = self.files()
        self.assertEqual((files["roadmap-engine.env"], files["maintenance/on"]), (b"ROADMAP_ENGINE_ENABLED=1\n", f"roadmap cutover {RUN}\n".encode()))
        self.stage.assert_nothing_private(self, log)

    def test_a_restore_pg_restore_refuses_keeps_the_moved_database_named_windmill_and_the_pause_and_prints_no_row(self):
        self.model(tool={"stdout": STOPPED, "stderr": "", "exit": 3, "record": {}}, restoreFails=True)
        outcomes, log = self.stage.job().run()
        self.assertEqual(outcomes["Restore the backup"], "failure")
        self.assertEqual(printed(log, "Restore the backup"),
                         "FAIL restore: pg_restore did not restore the backup; windmill is as the move left it, and Postgres' words are "
                         f"in roadmap-cutover/{RUN}/restore.log\n")
        files = self.files()
        self.assertIn(b"PRIVATE_ROW_CANARY", files[f"roadmap-cutover/{RUN}/restore.log"])
        self.assertEqual((self.model()["databases"], self.model()["server"]["running"], "maintenance/on" in files),
                         (["windmill", "windmill_restore"], False, True))
        self.stage.assert_nothing_private(self, log)

    def test_a_host_already_on_the_engine_or_on_another_image_is_refused_before_anything_changes(self):
        for change, reason in ((lambda: (self.stage.windmill / "roadmap-engine.env").write_text("ROADMAP_ENGINE_ENABLED=1\n"),
                                "roadmap is on the sync engine here already"),
                               (lambda: self.model(imageId="sha256:" + "e" * 64), "the server is not running its pinned image"),
                               (lambda: self.model(toolCarried=False), "the live image does not carry windmill_roadmap_adopt"),
                               (lambda: self.model(databaseBytes=10 ** 15), "too little free disk for a backup and its restore")):
            with self.subTest(reason=reason):
                self.stage = Stage(self, "--model-docker-shim")
                executable(self.stage.root / "host/bin/sleep", "#!/bin/sh\nexit 0\n")
                self.model(tool={"stdout": PASSED, "stderr": "", "exit": 0, "record": {}})
                change()
                before = {name: text for name, text in self.files().items() if name != "roadmap-cutover.sh"}
                outcomes, log = self.stage.job().run()
                self.assertEqual((outcomes["check"], self.stage.host_stages()), ("failure", ["check"]))
                self.assertEqual(printed(log, "Check the host is ready").splitlines()[-1], f"FAIL check: {reason}")
                self.assertEqual({name: text for name, text in self.files().items() if name != "roadmap-cutover.sh"}, before)


class MaintenanceDoorTest(unittest.TestCase):
    def test_the_door_pauses_and_lifts_the_site_and_proves_each_through_its_public_page(self):
        stage = Stage(self, "--model-docker-shim")
        (stage.home / "state.json").write_text(json.dumps({"server": {"running": True}}))
        definition = mapping((REPOSITORY / ".github/workflows/ops-maintenance.yml").read_text().splitlines())
        self.assertEqual((definition["on"], definition["permissions"], "concurrency" in definition),
                         ({"workflow_dispatch": {"inputs": {"switch": {"description": "Pause or lift the site", "required": "true",
                                                                       "type": "choice", "options": "[lift, pause]"}}}},
                          {"contents": "read"}, False))
        for switch, line, paused in (("pause", "PASS maintenance: the site is paused; https://app.localhost answers 503 on its page\n", True),
                                     ("lift", "PASS maintenance: the site is lifted; https://app.localhost answers 200 on its page\n", False)):
            with self.subTest(switch=switch):
                job = Job(definition["jobs"]["maintenance"], {**stage.context, "inputs.switch": switch}, stage.workspace,
                          stage.environment, stage.root / "artifact", stage.root / "artifacts")
                outcomes, log = job.run()
                self.assertEqual((outcomes, log[0][1:], (stage.windmill / "maintenance/on").exists()),
                                 ({"Pause or lift the site": "success"}, (0, line), paused))


# The VPS as a local stack: compose's services mapped onto a Postgres database of their own, the built tool, the built
# server on a port of its own, and Caddy's image serving the production Caddyfile in front of a stand-in that forwards to
# that server.
STACK_PREFIX = "wm_roadmap_cutover_"
SERVER_PORT = 5426


def stack():
    return json.loads((Path(os.environ["WM_HOST_HOME"]) / "stack.json").read_text())


def stack_database(name):
    return STACK_PREFIX + name


def stack_url(name):
    return re.sub(r"^(postgres(?:ql)?://[^/?]*)/[^?]*", rf"\1/{stack_database(name)}", os.environ["DATABASE_URL"])


def stack_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, TypeError):
        return False


def stack_docker(arguments):
    state = stack()
    host = Path(os.environ["WM_HOST_HOME"]) / "windmill"
    server = state.get("serverPid")
    if arguments == ["compose", "ps", "-q", "server"]:
        print("windmill-server" if stack_alive(server) else "")
        return 0
    if arguments == ["inspect", "--format", "{{.Image}}", "windmill-server"]:
        print(PINNED)
        return 0
    if arguments[:2] == ["rm", "-f"]:
        return 0
    if arguments == ["compose", "stop", "server"]:
        if stack_alive(server):
            os.kill(server, signal.SIGTERM)
            deadline = time.monotonic() + 15
            while stack_alive(server) and time.monotonic() < deadline:
                time.sleep(0.1)
            if stack_alive(server):
                os.kill(server, signal.SIGKILL)
        return 0
    if arguments in (["compose", "start", "server"], ["compose", "up", "-d", "--no-deps", "--pull", "never", "server"]):
        if arguments[1] == "up" and stack_alive(server):
            stack_docker(["compose", "stop", "server"])
        if arguments[1] == "up" or not stack_alive(server):
            switch = dict(line.split("=", 1) for line in (host / "roadmap-engine.env").read_text().splitlines() if line)
            log = open(state["serverLog"], "a")
            process = subprocess.Popen([os.environ["WM_CUTOVER_SERVER"]], stdout=log, stderr=log, start_new_session=True,
                                       env={"PATH": os.environ["PATH"], "DATABASE_URL": stack_url("windmill"),
                                            "PORT": str(SERVER_PORT), "WINDMILL_WEB_ROOT": str(host / "web"), **switch})
            state.update(serverPid=process.pid, serverEnv=switch)
            (Path(os.environ["WM_HOST_HOME"]) / "stack.json").write_text(json.dumps(state))
        return 0
    if arguments == ["compose", "run", "--rm", "--no-deps", "-T", "migrate"]:
        return subprocess.run(["psql", stack_url("windmill"), "-Xq", "-v", "ON_ERROR_STOP=1", "-f",
                               str(REPOSITORY / "backend/db/schema.sql")]).returncode
    if arguments[:5] == ["compose", "run", "--rm", "--no-deps", "-T"]:
        volumes = dict(tuple(reversed(arguments[index + 1].split(":")[:2])) for index, argument in enumerate(arguments)
                       if argument == "--volume")
        settings = dict(arguments[index + 1].split("=", 1) for index, argument in enumerate(arguments) if argument == "--env")
        settings = {key: volumes.get(value, value) for key, value in settings.items()}
        return subprocess.run([os.environ["WM_CUTOVER_TOOL"], arguments[-1]],
                              env={"PATH": os.environ["PATH"], "DATABASE_URL": stack_url("windmill"), "SENTRY_DSN": "", **settings}).returncode
    exec_in = arguments[3] if arguments[:3] == ["compose", "exec", "-T"] else None
    command = arguments[4:]
    if exec_in == "caddy":
        return subprocess.run([os.environ["WM_DOCKER"], "exec", state["edge"], *command]).returncode
    if exec_in == "server" and command[0] == "sh":
        if "command -v windmill_roadmap_adopt" in command[2]:
            return 0 if Path(os.environ["WM_CUTOVER_TOOL"]).is_file() else 1
        return 0 if stack_alive(server) and state.get("serverEnv", {}).get("ROADMAP_ENGINE_ENABLED") == "1" else 1
    if exec_in == "server" and command[0] == "curl":
        return subprocess.run([os.environ["WM_CURL"], *[argument.replace("127.0.0.1:8080", f"127.0.0.1:{SERVER_PORT}")
                                                       for argument in command[1:]]]).returncode
    if exec_in == "db" and command[0] == "psql":
        database = next(argument for argument in command if argument.startswith("--dbname=")).split("=", 1)[1]
        sql = re.sub(r"\bwindmill(_restore|_cutover_[0-9_]+)?\b", lambda match: STACK_PREFIX + match.group(0), command[-1])
        target = os.environ["DATABASE_URL"] if database == "postgres" else stack_url(database)
        return subprocess.run(["psql", target, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql]).returncode
    if exec_in == "db" and command[0] == "df":
        return subprocess.run(["df", "-Pk", "/"]).returncode
    if exec_in == "db" and command[0] == "pg_dump":
        return subprocess.run(["pg_dump", stack_url("windmill"), "--format=custom"]).returncode
    if exec_in == "db" and command[:2] == ["pg_restore", "--list"]:
        listing = subprocess.run(["pg_restore", "--list"], capture_output=True, text=True)
        sys.stdout.write(listing.stdout.replace(f"dbname: {STACK_PREFIX}windmill", "dbname: windmill"))
        sys.stderr.write(listing.stderr)
        return listing.returncode
    if exec_in == "db" and command[0] == "createdb":
        return subprocess.run(["psql", os.environ["DATABASE_URL"], "-XAtq", "-c",
                               f'create database "{stack_database(command[-1])}"']).returncode
    if exec_in == "db" and command[0] == "pg_restore":
        database = next(argument for argument in command if argument.startswith("--dbname=")).split("=", 1)[1]
        return subprocess.run(["pg_restore", "--dbname", stack_url(database), *[argument for argument in command[1:]
                               if not argument.startswith(("--username=", "--dbname="))]]).returncode
    raise AssertionError("unmodeled docker command: " + repr(arguments))


def fingerprint(url):
    tables = subprocess.run(["psql", url, "-XAtq", "-c", "select tablename from pg_tables where schemaname = 'public' order by 1"],
                            check=True, capture_output=True, text=True).stdout.split()
    sql = " union all ".join(f"select '{table}', md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from {table} t"
                             for table in tables)
    answer = subprocess.run(["psql", url, "-XAtq", "-c", sql], check=True, capture_output=True, text=True).stdout
    return dict(line.split("|", 1) for line in answer.splitlines())


@unittest.skipUnless(os.environ.get("WM_CUTOVER_TOOL") and os.environ.get("WM_CUTOVER_SERVER") and os.environ.get("DATABASE_URL"),
                     "a local stack needs WM_CUTOVER_TOOL, WM_CUTOVER_SERVER and a maintenance DATABASE_URL")
class CutoverOnALocalStackTest(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.stage = Stage(self, "--stack-docker-shim")
        self.network = "roadmap-cutover-" + RUN
        subprocess.run(["docker", "network", "create", self.network], check=True, capture_output=True)
        self.addCleanup(subprocess.run, ["docker", "network", "rm", self.network], capture_output=True)
        forward = subprocess.run(["docker", "run", "-d", "--network", self.network, "--network-alias", "server",
                                  "--add-host", "host.docker.internal:host-gateway", "caddy:2", "caddy", "reverse-proxy",
                                  "--from", ":8080", "--to", f"host.docker.internal:{SERVER_PORT}"],
                                 check=True, capture_output=True, text=True).stdout.strip()
        self.addCleanup(subprocess.run, ["docker", "rm", "-f", forward], capture_output=True)
        edge = subprocess.run(["docker", "run", "-d", "--network", self.network, "-p", "127.0.0.1:5427:443",
                               "-e", "DOMAIN_APP=app.localhost", "-e", "DOMAIN_API=api.localhost", "-e", "ACME_EMAIL=ops@example.invalid",
                               "-e", "CF_IPS=0.0.0.0/0 ::/0", "-v", f"{REPOSITORY / 'backend/deploy/Caddyfile'}:/etc/caddy/Caddyfile:ro",
                               "-v", f"{self.stage.windmill / 'web'}:/srv/windmill-web:ro",
                               "-v", f"{self.stage.windmill / 'maintenance'}:/srv/windmill-maintenance:ro", "caddy:2"],
                              check=True, capture_output=True, text=True).stdout.strip()
        self.addCleanup(subprocess.run, ["docker", "rm", "-f", edge], capture_output=True)
        self.stage.environment["WM_EDGE_PORT"] = "5427"
        (self.stage.home / "stack.json").write_text(json.dumps({"edge": edge, "serverLog": str(self.stage.root / "server.log")}))
        self.addCleanup(self.stop_server)
        for name in ("windmill", "windmill_restore", f"windmill_cutover_{RUN.replace('-', '_')}"):
            self.addCleanup(self.psql, os.environ["DATABASE_URL"], f'drop database if exists "{stack_database(name)}" with (force)')

    def psql(self, url, sql):
        return subprocess.run(["psql", url, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql], check=True, capture_output=True,
                              text=True).stdout.strip()

    def stop_server(self):
        os.environ["WM_HOST_HOME"] = str(self.stage.home)
        stack_docker(["compose", "stop", "server"])

    def seed(self, sql=""):
        self.psql(os.environ["DATABASE_URL"], f'drop database if exists "{stack_database("windmill")}" with (force)')
        self.psql(os.environ["DATABASE_URL"], f'create database "{stack_database("windmill")}" template template0 encoding \'UTF8\'')
        schema, fixture = REPOSITORY / "backend/db/schema.sql", REPOSITORY / "backend/test/platform/infra/roadmap_adopt_fixture.sql"
        for file in (schema, fixture):
            subprocess.run(["psql", stack_url("windmill"), "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(file)], check=True, capture_output=True)
        if sql:
            self.psql(stack_url("windmill"), sql)
        # As every deploy has: the schema applied again over the rows, so a restore's own application of it changes none.
        subprocess.run(["psql", stack_url("windmill"), "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(schema)], check=True, capture_output=True)
        os.environ["WM_HOST_HOME"] = str(self.stage.home)
        stack_docker(["compose", "start", "server"])

    def adopt_again(self):
        os.environ["WM_HOST_HOME"] = str(self.stage.home)
        stack_docker(["compose", "stop", "server"])
        with tempfile.TemporaryDirectory() as record:
            expected = Path(record) / "expected-ownerless"
            expected.write_text(EXPECTED_OWNERLESS)
            return subprocess.run([os.environ["WM_CUTOVER_TOOL"], "all"], capture_output=True, text=True, timeout=600,
                                  env={"PATH": os.environ["PATH"], "DATABASE_URL": stack_url("windmill"), "SENTRY_DSN": "",
                                       "ROADMAP_ADOPTION_PRIVATE_DIR": str(Path(record) / "record"),
                                       "ROADMAP_ADOPTION_EXPECTED_OWNERLESS": str(expected)})

    def test_the_cutover_moves_the_fixture_through_every_stage_and_a_second_run_changes_nothing(self):
        self.seed()
        started = time.monotonic()
        outcomes, log = self.stage.job().run()
        print(f"\ncutover on the local stack: {time.monotonic() - started:.1f} s", file=sys.stderr)
        for label, code, output in log:
            print(f"--- {label} (exit {code})\n{output}", end="", file=sys.stderr)
        self.assertEqual({step: outcome for step, outcome in outcomes.items() if outcome != "success" and step not in ("smoke", "lift")},
                         {"Restore the backup": "skipped", "Return the site as it was": "skipped"})
        verdicts = [json.loads(line) for line in printed(log, "Adopt roadmap's rows and check every digest").splitlines() if line.startswith("{")]
        self.assertEqual([(report["stage"], report["verdict"]) for report in verdicts],
                         list(zip(STAGES, ["unfolded", "asked", "ready", "adopted", "present", "same", "same", "summed"])))
        names, record = self.stage.sealed()
        self.assertEqual((names, sorted(record)), (["key.pem", "record.tar.enc"], [
            "after.jsonl", "before.jsonl", "differences.jsonl", "digests.jsonl", "read-models-before.jsonl", "read-models.jsonl",
            "stops.jsonl", "tool.stderr"]))
        self.stage.assert_nothing_private(self, log, ["PRIVATE_SSH_KEY_CANARY", "Learn the cello", "Practise daily", "owner@example.com",
                                                      "aaaaaaaa-0000-4000-8000-00000000000a", "t_a000000000000001", "t_c000000000000001"])
        adopted = fingerprint(stack_url("windmill"))
        again = self.adopt_again()
        reports = [json.loads(line) for line in again.stdout.splitlines()]
        self.assertEqual((again.returncode, [(report["stage"], report["verdict"]) for report in reports]),
                         (0, list(zip(STAGES, ["unfolded", "asked", "ready", "unchanged", "present", "same", "same", "summed"]))))
        self.assertEqual(fingerprint(stack_url("windmill")), adopted)
        # The stack's walk and the pause's lift, last: they need the build that answers the retired routes 410 (§8.3).
        self.assertEqual((outcomes["smoke"], outcomes["lift"]), ("success", "success"), printed(log, "Walk the stack"))

    def test_a_stop_restores_the_backup_and_returns_the_site_as_it_was(self):
        self.seed("insert into tree_nodes (tree_id, node_id, created_hlc, status, status_hlc, present) values "
                  "('t_a000000000000001', 'odd', '1740000000000:90:r_owner', 'banana', '1740000000000:90:r_owner', true)")
        os.environ["WM_HOST_HOME"] = str(self.stage.home)
        stack_docker(["compose", "stop", "server"])
        before = fingerprint(stack_url("windmill"))
        stack_docker(["compose", "start", "server"])
        outcomes, log = self.stage.job().run()
        for label, code, output in log:
            print(f"--- {label} (exit {code})\n{output}", end="", file=sys.stderr)
        self.assertEqual({step: outcomes[step] for step in ("adopt", "seal", "start", "Restore the backup", "Return the site as it was")},
                         {"adopt": "failure", "seal": "success", "start": "skipped", "Restore the backup": "success",
                          "Return the site as it was": "skipped"})
        verdicts = [json.loads(line) for line in printed(log, "Adopt roadmap's rows and check every digest").splitlines() if line.startswith("{")]
        self.assertEqual([(report["stage"], report["verdict"], report["counts"].get("stop")) for report in verdicts],
                         [("unfold", "unfolded", None), ("read-models-before", "asked", None), ("before", "stops", {"unknownStepStatus": 1})])
        self.assertEqual(self.stage.sealed()[1]["stops.jsonl"], '{"reason":"stop.unknownStepStatus","roadmap":"t_a000000000000001"}\n')
        stack_docker(["compose", "stop", "server"])
        self.assertEqual(fingerprint(stack_url("windmill")), before)
        moved = stack_url(f"windmill_cutover_{RUN.replace('-', '_')}")
        self.assertNotEqual(fingerprint(moved), before)
        self.assertEqual(((self.stage.windmill / "roadmap-engine.env").read_text(), (self.stage.windmill / "maintenance/on").exists()),
                         ("", False))


def ssh_shim(arguments):
    index = 0
    while arguments[index] in ("-i", "-p", "-o"):
        index += 2
    command = " ".join(arguments[index + 1:])
    with open(os.environ["WM_SSH_CALLS"], "a") as calls:
        calls.write(command + "\n")
    home = os.environ["WM_HOST_HOME"]
    return subprocess.run(["bash", "-c", command], cwd=home,
                          env={**os.environ, "HOME": home, "PATH": os.environ["WM_HOST_BIN"] + os.pathsep + os.environ["PATH"]}).returncode


def rsync_shim(arguments):
    source, target = Path(arguments[-2]), Path(os.environ["WM_HOST_HOME"]) / arguments[-1].split(":", 1)[1]
    for path in target.iterdir():
        if not re.fullmatch(r"[0-9a-f]{32}\.txt", path.name):
            shutil.rmtree(path) if path.is_dir() else path.unlink()
    shutil.copytree(source, target, dirs_exist_ok=True)
    return 0


def curl_shim(arguments):
    url = arguments[-1]
    if os.environ.get("WM_EDGE_PORT"):
        port = os.environ["WM_EDGE_PORT"]
        address = url.replace("https://app.localhost", f"https://app.localhost:{port}")
        return subprocess.run([os.environ["WM_CURL"], "-k", "--resolve", f"app.localhost:{port}:127.0.0.1", "-H", "CF-Connecting-IP: 203.0.113.7",
                               *arguments[:-1], address]).returncode
    home = Path(os.environ["WM_HOST_HOME"])
    running = json.loads((home / "state.json").read_text())["server"]["running"]
    print(503 if (home / "windmill/maintenance/on").exists() else 200 if running else 502, end="")
    return 0


if __name__ == "__main__":
    shims = {"--model-docker-shim": model_docker, "--stack-docker-shim": stack_docker, "--ssh-shim": ssh_shim,
             "--rsync-shim": rsync_shim, "--curl-shim": curl_shim}
    if sys.argv[1:2] and sys.argv[1] in shims:
        sys.exit(shims[sys.argv[1]](sys.argv[2:]))
    unittest.main()
