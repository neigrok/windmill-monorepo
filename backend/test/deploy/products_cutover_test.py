#!/usr/bin/env python3
import argparse
import copy
import fcntl
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit, urlunsplit

sys.dont_write_bytecode = True
BACKEND = Path(__file__).resolve().parents[2]
SELF = Path(__file__).resolve()
SCRIPT = BACKEND / "deploy/gym-migration/cutover-production.sh"
SWITCHES = {"GYM_ENGINE_WRITES": "1", "JOURNAL_ENGINE_WRITES": "1",
            "GYM_WRITE_FREEZE": "0", "JOURNAL_WRITE_FREEZE": "0", "SYNC_ENABLED": "0"}
OLD_SWITCHES = {**SWITCHES, "GYM_ENGINE_WRITES": "0", "JOURNAL_ENGINE_WRITES": "0"}
SECRET = "products-cutover-private-test-token"
IMAGE = "sha256:" + "a" * 64


def command(arguments, environment=None, input=None):
    result = subprocess.run([str(value) for value in arguments], env=environment, input=input,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise AssertionError(f"{Path(str(arguments[0])).name} failed ({result.returncode}): "
                             + result.stderr.decode(errors="replace"))
    return result.stdout


def update_state(update):
    path = Path(os.environ["WM_CUTOVER_STATE"])
    with Path(str(path) + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(path.read_text())
        update(state)
        temporary = Path(str(path) + f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(state))
        os.replace(temporary, path)
        return state


def event(name, pause=False):
    injected = False
    def record(state):
        nonlocal injected
        state["events"].append(name)
        kind = "kill" if name == state.get("killAt") else "fail" if name == state.get("failAt") else None
        if kind and not state.get(kind + "Fired"):
            state[kind + "Fired"] = True
            state["injectionFired"] = True
            state["injectionEvent"] = name
            injected = True
    state = update_state(record)
    if not injected:
        return False
    if state.get("killAt") == name:
        os.kill(state["scriptPid"], signal.SIGKILL)
        if pause:
            # Preserve the runner until the next invocation kills it.
            while True:
                time.sleep(1)
        return False
    if state.get("failAt") == name:
        print(SECRET, file=sys.stderr)  # Prove diagnostics do not expose process output.
        return True
    return False


def env_file(path):
    return dict(line.split("=", 1) for line in Path(path).read_text().splitlines()
                if line and not line.startswith("#"))


def compose_env(path):
    values = env_file(path)
    values.update({key: value for key, value in os.environ.items() if key in SWITCHES})
    return values


def db_arguments(arguments, state):
    result = []
    previous = None
    for argument in arguments:
        if previous in ("--dbname", "-d"):
            argument = state["maintenanceDb"] if argument == "postgres" else state["databaseUrl"]
        elif argument.startswith("--dbname="):
            argument = "--dbname=" + (state["maintenanceDb"] if argument.split("=", 1)[1] == "postgres"
                                      else state["databaseUrl"])
        elif argument.startswith(("postgres://", "postgresql://")) and "@db:" in argument:
            argument = state["databaseUrl"]
        result.append(argument)
        previous = argument
    return result


def tool_shim(tool, arguments):
    state = update_state(lambda current: current["toolCalls"].append([tool, *arguments]))
    if (tool == "pg_dump" and "--format=custom" in arguments) or (tool == "pg_restore" and "--clean" in arguments):
        assert all(not row["State"]["Running"] and row["HostConfig"]["RestartPolicy"]["Name"] == "no"
                   for row in state["containers"].values()
                   if row["Config"]["Labels"]["com.docker.compose.service"] != "db"), "writer active at backup/restore"
    if tool == "curl":
        server = next(row for row in state["containers"].values()
                      if row["Config"]["Labels"]["com.docker.compose.service"] == "server")
        assert server["State"]["Running"], "smoke ran while server was stopped"
        if event("smoke"):
            return 1
        arguments = [argument.replace("localhost:8080", "127.0.0.1:" + str(state["serverPort"]))
                     .replace("127.0.0.1:8080", "127.0.0.1:" + str(state["serverPort"]))
                     for argument in arguments]
    elif tool in ("sha256sum", "shasum"):
        if event("checksum"):
            return 1
    else:
        arguments = db_arguments(arguments, state)
    if tool == "pg_restore" and "--clean" in arguments:
        event("automatic-restore-before-start", pause=True)
    recovery_kill = tool == "pg_restore" and "--clean" in arguments and state.get("killAt") == "recovery-restore" and not state.get("killFired")
    if recovery_kill:
        archive = sys.stdin.buffer.read()
        result = subprocess.run([state["tools"][tool], *arguments, "--section=pre-data"], input=archive, check=False)
        if result.returncode:
            return result.returncode
        source = Path(state["workDir"]) / "interrupted-restore.dump"
        source.write_bytes(archive)
        subprocess.Popen([state["tools"]["psql"], state["databaseUrl"], "-XAtq", "-v", "ON_ERROR_STOP=1", "-c",
            "BEGIN; LOCK TABLE public.users IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(600)"],
            env={**os.environ, "PGAPPNAME": "cutover-test-restore-lock"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def waiting(sql):
            return subprocess.run([state["tools"]["psql"], state["databaseUrl"], "-XAtq", "-c", sql],
                                  capture_output=True, check=True).stdout.strip() == b"t"
        for _ in range(100):
            if waiting("SELECT EXISTS (SELECT FROM pg_locks WHERE relation='users'::regclass "
                       "AND mode='AccessExclusiveLock' AND granted)"):
                break
            time.sleep(0.01)
        else:
            raise AssertionError("restore test lock was not acquired")
        lock_backend = command([state["tools"]["psql"], state["databaseUrl"], "-XAtq", "-c",
            "SELECT pid FROM pg_stat_activity WHERE application_name='cutover-test-restore-lock' "
            "AND datname=current_database()"])
        update_state(lambda current: current.update(restoreLockBackend=int(lock_backend.strip())))
        restore = subprocess.Popen([state["tools"][tool], "--dbname=" + state["databaseUrl"],
                                    "--exit-on-error", "--section=data", str(source)])
        for _ in range(100):
            if waiting("SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database() "
                       "AND application_name='pg_restore' AND wait_event_type='Lock')"):
                break
            assert restore.poll() is None, "real restore completed before interruption"
            time.sleep(0.01)
        else:
            raise AssertionError("real pg_restore was not blocked in flight")
        update_state(lambda current: current.update(realRestoreBlocked=True))
        event("recovery-restore", pause=True)
        raise AssertionError("in-flight recovery kill did not fire")
    result = subprocess.run([state["tools"][tool], *arguments], check=False)
    if result.returncode:
        return result.returncode
    if tool == "pg_dump" and "--format=custom" in arguments:
        if event("dump"):
            return 1
    if tool == "pg_restore" and "--list" in arguments:
        if event("list"):
            return 1
        event("backup")
        if list(Path(state["workDir"]).glob("migration-evidence/products-cutover-*/rollback.dump.sha256")):
            event("verified-backup")
    if tool == "pg_restore" and "--clean" in arguments:
        update_state(lambda current: current["events"].append("restored"))
    return 0


def rehearse_shim(arguments):
    spec = importlib.util.spec_from_file_location("production_rehearsal", arguments[0])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    original = module.run

    def observed(arguments, environment, output=None, sql=None):
        name = Path(str(arguments[0])).name
        assert "--test-corruptions" not in arguments, "production ran fault-injection audit"
        result = original(arguments, environment, output, sql)
        selected = name.startswith("windmill_") or "-f" in arguments or (name == "bash" and "apply" in arguments)
        if not selected:
            return result
        update_state(lambda current: current["migrationTools"].append(
            [name, *[str(argument) for argument in arguments[1:] if not str(argument).startswith(("postgres", "dbname="))]]))
        objects = subprocess.run(["psql", environment["DATABASE_URL"], "-XAtq", "-v", "ON_ERROR_STOP=1", "-c",
            "SELECT (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'wm_journal_rehearsal_pause_%') + "
            "(SELECT count(*) FROM pg_proc WHERE proname LIKE 'wm_journal_rehearsal_pause_%')"],
            env=environment, capture_output=True, check=True).stdout
        assert objects.strip() == b"0", "production operation installed a rehearsal fixture"
        checkpoint = None
        if name == "psql" and any(str(arg).endswith("/gym_sync.sql") for arg in arguments):
            checkpoint = "schema"
        elif name == "psql" and any(str(arg).endswith("/journal_sync.sql") for arg in arguments):
            checkpoint = "journal-schema"
        elif output:
            checkpoint = {"gym-migration.jsonl": "backfill", "journal-migration.jsonl": "journal-backfill",
                "gym-audit.jsonl": "audit", "journal-audit.jsonl": "journal-audit",
                "bootstrap-rerun.log": "bootstrap", "gym-bootstrap-audit.jsonl": "gym-bootstrap-audit",
                "journal-bootstrap-audit.jsonl": "journal-bootstrap-audit"}.get(Path(output).name)
        if checkpoint and event(checkpoint, pause=True):
            raise RuntimeError("injected " + checkpoint + " operation failure")
        return result

    module.run = observed
    sys.argv = list(arguments)
    assert "--disposable-fixtures" not in sys.argv, "production enabled disposable fixtures"
    module.main()


def docker_shim(arguments):
    state = update_state(lambda current: current["commands"].append(arguments))
    if arguments[0] == "compose":
        candidate = False
        index = 1
        while arguments[index].startswith("--") or arguments[index] == "-f":
            assert arguments[index] in ("--env-file", "-f"), arguments
            candidate = True
            index += 2
        args = arguments[index:]
        if args == ["version"]:
            return 1 if state.get("composeUnavailable") else 0
        if args[0] == "ps":
            service = args[-1]
            all_containers = args[1] == "-aq"
            for identifier, row in state["containers"].items():
                if row["Config"]["Labels"]["com.docker.compose.service"] == service and (all_containers or row["State"]["Running"]):
                    print(identifier)
            return 0
        if args == ["config", "--format", "json"]:
            config = copy.deepcopy(state["composeConfig"])
            config["services"]["server"]["environment"] = compose_env(".env.next" if candidate else ".env")
            print(json.dumps(config))
            return 0
        if args == ["config", "-q"]:
            if not candidate and compose_env(".env").get("GYM_ENGINE_WRITES") == "1" and event("prepare"):
                return 1
            return 0
        if args == ["pull"]:
            return 0
        if args[0] == "run":
            entrypoint = args.index("--entrypoint")
            assert candidate and args[entrypoint + 2:] == ["server", "--audit-current"], args
            assert "--pull" in args and args[args.index("--pull") + 1] == "never", args
            environment = {**os.environ, **env_file(".env.next"), "DATABASE_URL": state["databaseUrl"]}
            return subprocess.run([str(Path(state["binDir"]) / args[entrypoint + 1]), "--audit-current"],
                                  env=environment, check=False).returncode
        if args[:3] == ["exec", "-T", "db"]:
            database_env = {"POSTGRES_USER": state["postgresUser"], "POSTGRES_DB": state["databaseName"],
                            "POSTGRES_PASSWORD": SECRET}
            invocation = [argument.replace("/app", str(BACKEND)) for argument in args[3:]]
            return subprocess.run(invocation, env={**os.environ, **database_env}, check=False).returncode
        if args[:3] == ["exec", "-T", "server"]:
            invocation = [argument.replace("/app", str(BACKEND)) for argument in args[3:]]
            if Path(invocation[0]).name.startswith("windmill_"):
                assert invocation[1:] == ["--audit-current"], invocation
                invocation[0] = str(Path(state["binDir"]) / invocation[0])
            environment = {**os.environ, **env_file(".env"), "DATABASE_URL": state["databaseUrl"]}
            return subprocess.run(invocation, env=environment, check=False).returncode
        if args[:3] == ["exec", "-T", "caddy"]:
            mounted = state.get("caddyFile", Path("Caddyfile").read_text())
            if args[3:] == ["cat", "/etc/caddy/Caddyfile"]:
                sys.stdout.write(mounted)
            elif args[3:5] == ["caddy", "adapt"]:
                print(json.dumps({"file": mounted}))
            elif args[3:5] == ["caddy", "reload"]:
                if not state.get("caddyStaleConfig"):
                    update_state(lambda current: current.update(caddyActive={"file": mounted}))
            elif args[3:] == ["wget", "-qO-", "http://127.0.0.1:2019/config/"]:
                print(json.dumps(state["caddyActive"]))
            else:
                raise AssertionError("unmodeled Caddy command: " + repr(args))
            return 0
        if args[0] == "up":
            assert "--pull" in args and args[args.index("--pull") + 1] == "never", args
            if "--force-recreate" not in args:
                event("deploy-promoted", pause=True)
            services = [value for index, value in enumerate(args[1:], 1)
                        if not value.startswith("-") and args[index - 1] != "--pull"]
            services = services or list(state["composeConfig"]["services"])
            current_env = {**state["productionRuntime"], **compose_env(".env")}
            def start(current):
                if "caddy" in services and ("--force-recreate" in args or "caddyFile" not in current):
                    if not current.get("caddyStaleMount"):
                        current["caddyFile"] = Path("Caddyfile").read_text()
                    if not current.get("caddyStaleConfig"):
                        current["caddyActive"] = {"file": current["caddyFile"]}
                for row in current["containers"].values():
                    service = row["Config"]["Labels"]["com.docker.compose.service"]
                    if service in services:
                        row["State"]["Running"] = service != "migrate"
                        if service == "server":
                            row["Config"]["Env"] = [f"{key}={value}" for key, value in current_env.items()]
                current["events"].append("started-engine" if current_env.get("GYM_ENGINE_WRITES") == "1" else "started-old")
            state = update_state(start)
            if current_env.get("GYM_ENGINE_WRITES") == "1" and "server" in services:
                log = open(Path(state["workDir"]) / "server.log", "ab")
                process = subprocess.Popen([str(Path(state["binDir"]) / "windmill_server")],
                    env={**os.environ, **current_env, "DATABASE_URL": state["databaseUrl"], "PORT": str(state["serverPort"])},
                    stdout=log, stderr=log, start_new_session=True)
                update_state(lambda current: current.update(serverProcessGroup=process.pid))
                for _ in range(100):
                    probe = subprocess.run([state["tools"]["curl"], "-s", "-o", "/dev/null", "--max-time", "1",
                                           f"http://127.0.0.1:{state['serverPort']}/"], capture_output=True, check=False)
                    if probe.returncode == 0:
                        break
                    if process.poll() is not None:
                        raise AssertionError("real server did not start: " + (Path(state["workDir"]) / "server.log").read_text())
                    time.sleep(0.05)
                else:
                    raise AssertionError("real server did not accept traffic")
            if event("start"):
                return 1
            return 0
        raise AssertionError("unmodeled compose command: " + repr(arguments))
    if arguments[0] == "inspect":
        assert all(identifier in state["containers"] for identifier in arguments[1:]), arguments
        print(json.dumps([state["containers"][identifier] for identifier in arguments[1:]]))
        return 0
    if arguments[:2] == ["image", "inspect"]:
        if ".Id" in arguments[3]:
            print(IMAGE)
        else:
            print(state["imageCompatibility"] or "<no value>")
        return 0
    if arguments[:2] == ["ps", "-aq"]:
        if arguments[2:] == ["--filter", "name=^/windmill-products-cutover$"]:
            if state.get("migrationProcessGroup"):
                print("runner")
            return 0
        assert arguments[2:] == ["--no-trunc", "--filter", "label=com.docker.compose.project=windmill"], arguments
        print("\n".join(state["containers"]))
        return 0
    if arguments[0] == "update":
        def change(current):
            for identifier in arguments[2:]:
                current["containers"][identifier]["HostConfig"]["RestartPolicy"]["Name"] = arguments[1].split("=", 1)[1]
        update_state(change)
        return 0
    if arguments[:3] == ["stop", "--time", "60"]:
        def stop(current):
            for identifier in arguments[3:]:
                current["containers"][identifier]["State"]["Running"] = False
        state = update_state(stop)
        if all(not row["State"]["Running"] for row in state["containers"].values()
               if row["Config"]["Labels"]["com.docker.compose.service"] != "db"):
            event("stop")
        return 0
    if arguments[0] == "start":
        def restart(current):
            for identifier in arguments[1:]:
                current["containers"][identifier]["State"]["Running"] = True
            current["events"].append("started-old")
        update_state(restart)
        event("old-start")
        return 0
    if arguments[:2] == ["rm", "-f"]:
        if state.get("migrationProcessGroup"):
            try:
                os.killpg(state["migrationProcessGroup"], signal.SIGKILL)
            except ProcessLookupError:
                pass
        if state.get("restoreLockBackend"):
            command([state["tools"]["psql"], state["maintenanceDb"], "-XAtq", "-c",
                     f"SELECT pg_terminate_backend({state['restoreLockBackend']})"])
            update_state(lambda current: current.pop("restoreLockBackend", None))
        update_state(lambda current: (current["events"].append("runner-removed"), current.pop("migrationProcessGroup", None)))
        return 0
    if arguments[0] == "run":
        options = {}
        index = 1
        while arguments[index].startswith("--") or arguments[index] == "-i":
            name = arguments[index]
            if name in ("--rm", "-i"):
                options[name] = True
                index += 1
            elif "=" in name:
                key, value = name.split("=", 1)
                options[key] = value
                index += 1
            else:
                options[name] = arguments[index + 1]
                index += 2
        assert arguments[index] == IMAGE, arguments
        invocation = arguments[index + 1:]
        if options.get("--network") == "none":
            invocation = [str(BACKEND / "deploy/gym-migration/schema-compatibility.sh")
                          if value.endswith("/schema-compatibility.sh") else value for value in invocation]
            invocation.append(str(BACKEND / "db/schema.sql"))
            status = subprocess.run(invocation, check=False).returncode
            event("precondition")
            return status
        assert options["--restart"] == "no" and options["--name"] == "windmill-products-cutover", options
        assert options["--network"] == "windmill_default", options
        if invocation[0] in ("pg_dump", "pg_restore"):
            environment = env_file(options["--env-file"])
            assert stat.S_IMODE(Path(options["--env-file"]).stat().st_mode) == 0o600
            assert environment["PGDATABASE"] == state["databaseName"] and environment["PGPASSWORD"] == SECRET
            invocation = [*invocation]
            if invocation[0] == "pg_dump" and not any(arg.startswith("--dbname") for arg in invocation):
                invocation.append("--dbname=" + state["databaseUrl"])
            process = subprocess.Popen([sys.executable, str(SELF), "--tool-shim", *invocation],
                                       env=os.environ, start_new_session=True)
            update_state(lambda current: current.update(migrationProcessGroup=process.pid))
            status = process.wait()
            update_state(lambda current: current.pop("migrationProcessGroup", None)
                         if current.get("migrationProcessGroup") == process.pid else None)
            return status
        mount = dict(field.split("=", 1) for field in options["--mount"].split(","))
        evidence = Path(mount["src"])
        assert mount["dst"] == "/evidence" and mount["type"] == "bind", mount
        environment = env_file(options["--env-file"])
        assert stat.S_IMODE(Path(options["--env-file"]).stat().st_mode) == 0o600
        assert all(not row["State"]["Running"] and row["HostConfig"]["RestartPolicy"]["Name"] == "no"
                   for row in state["containers"].values()
                   if row["Config"]["Labels"]["com.docker.compose.service"] != "db"), "writer active at migration"
        translated = []
        for value in invocation:
            value = value.replace("/app", str(BACKEND)).replace("/usr/local/bin", state["binDir"]).replace("/evidence", str(evidence))
            value = value.replace("python3 " + str(BACKEND / "deploy/gym-migration/rehearse.py"),
                shlex.join([sys.executable, str(SELF), "--rehearse-shim", str(BACKEND / "deploy/gym-migration/rehearse.py")]))
            translated.append(value)
        if translated[:1] == ["python3"]:
            translated = [sys.executable, str(SELF), "--rehearse-shim", *translated[1:]]
        assert "--disposable-fixtures" not in " ".join(translated), translated
        update_state(lambda current: current.update(migrationEvidence=str(evidence), migrationEnvironment=environment))
        process = subprocess.Popen(translated, env={**os.environ, **environment, "DATABASE_URL": state["databaseUrl"], "PATH": state["realPath"]},
                                   start_new_session=True)
        update_state(lambda current: current.update(migrationProcessGroup=process.pid))
        status = process.wait()
        update_state(lambda current: current.pop("migrationProcessGroup", None)
                     if current.get("migrationProcessGroup") == process.pid else None)
        return status
    raise AssertionError("unmodeled Docker command: " + repr(arguments))


class CutoverTest:
    def __init__(self, args, directory):
        self.args, self.directory, self.databases, self.states, self.cases = args, directory, [], [], 0
        self.postgres_user = command(["psql", args.maintenance_db, "-XAtq", "-c", "SELECT current_user"]).strip().decode()
        self.template = self.create_database()
        self.apply(self.template, "schema.sql")
        for product in ("gym", "journal"):
            command([args.bin_dir / f"windmill_{product}_rehearsal_seed"],
                    {**os.environ, **OLD_SWITCHES, "DATABASE_URL": self.database_url(self.template)})

    def database_url(self, name):
        if self.args.maintenance_db.startswith(("postgresql://", "postgres://")):
            parts = urlsplit(self.args.maintenance_db)
            if not parts.netloc:
                return parts.scheme + ":///" + name + ("?" + parts.query if parts.query else "")
            return urlunsplit(parts._replace(path="/" + name))
        return self.args.maintenance_db + " dbname=" + name

    def create_database(self, template=None):
        name = "wm_products_cutover_" + uuid.uuid4().hex
        command(["createdb", "--maintenance-db=" + self.args.maintenance_db,
                 *(["--template=" + template] if template else []), name])
        self.databases.append(name)
        return name

    def sql(self, database, source):
        return command(["psql", self.database_url(database), "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", source]).strip()

    def apply(self, database, *files):
        command(["psql", self.database_url(database), "-Xq", "-v", "ON_ERROR_STOP=1",
                 *[argument for name in files for argument in ("-f", str(BACKEND / "db" / name))]])

    def snapshot(self, database, row_versions=False):
        schema = command(["pg_dump", "--dbname", self.database_url(database), "--schema-only", "--no-owner", "--no-privileges"])
        schema = re.sub(rb"^\\(?:un)?restrict .+\n", b"", schema, flags=re.MULTILINE)
        rows = {}
        queries = ["SET timezone='UTC';"]
        row_value = ("jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text,'ctid',t.ctid::text)"
                     if row_versions else "to_jsonb(t)")
        relations = self.sql(database, "SELECT json_build_array(schemaname,tablename) FROM pg_tables "
            "WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%' "
            "ORDER BY schemaname,tablename")
        for row in relations.splitlines():
            namespace, table = json.loads(row)
            quoted = '"' + namespace.replace('"', '""') + '"."' + table.replace('"', '""') + '"'
            key = "'" + quoted.replace("'", "''") + "'"
            queries.append(f"SELECT json_build_array({key}, coalesce(string_agg({row_value}::text, E'\\n' "
                           f"ORDER BY to_jsonb(t)::text COLLATE \"C\"), '')) FROM {quoted} t;")
        sequences = self.sql(database, "SELECT json_build_array(sequence_schema,sequence_name) FROM information_schema.sequences "
                             "WHERE sequence_schema NOT IN ('pg_catalog','information_schema') ORDER BY sequence_schema,sequence_name")
        for row in sequences.splitlines():
            namespace, sequence = json.loads(row)
            quoted = '"' + namespace + '"."' + sequence + '"'
            key = "'" + quoted.replace("'", "''") + "'"
            queries.append(f"SELECT json_build_array({key}, last_value::text || '|' || "
                           f"CASE WHEN is_called THEN 't' ELSE 'f' END) FROM {quoted};")
        data = command(["psql", self.database_url(database), "-XAtq", "-v", "ON_ERROR_STOP=1"],
                       input="\n".join(queries).encode())
        for line in data.splitlines():
            key, value = json.loads(line)
            rows[key] = value.strip().encode()
        return schema, rows

    def adopted(self, database):
        return self.sql(database, "SELECT to_regclass('gym_sync_adoptions') IS NOT NULL OR "
                        "to_regclass('journal_sync_adoptions') IS NOT NULL") == b"t"

    def fixture(self, name, **injection):
        database = self.create_database(self.template)
        work = self.directory / name / "windmill"
        work.mkdir(parents=True)
        original = {**OLD_SWITCHES, "LEGACY_REST_WRITES_RETIRED": "0", "POSTGRES_PASSWORD": SECRET, "DOMAIN_APP": "cutover.example.invalid", "IMAGE_TAG": "tested"}
        (work / ".env").write_text("".join(f"{key}={value}\n" for key, value in original.items()))
        shutil.copyfile(BACKEND / "deploy/docker-compose.yml", work / "docker-compose.yml")
        shutil.copyfile(BACKEND / "deploy/Caddyfile", work / "Caddyfile")
        production_env = {**original, "DATABASE_URL": f"postgresql://{self.postgres_user}:{SECRET}@db:5432/{database}",
                          "WINDMILL_APP_URL": "https://cutover.example.invalid", "RESEND_API_KEY": SECRET}
        containers = {}
        services = ("db", "server", "worker", "migrate", "embedder", "caddy", "orphan-writer")
        for index, service in enumerate(services, 1):
            identifier = f"{index:064x}"
            environment = production_env if service != "db" else {
                "POSTGRES_USER": self.postgres_user, "POSTGRES_PASSWORD": SECRET, "POSTGRES_DB": database}
            containers[identifier] = {"Id": identifier, "Image": IMAGE, "State": {"Running": service != "migrate"},
                "Config": {"Env": [f"{key}={value}" for key, value in environment.items()],
                           "Labels": {"com.docker.compose.project": "windmill", "com.docker.compose.service": service}},
                "HostConfig": {"RestartPolicy": {"Name": "no" if service == "migrate" else "unless-stopped"}},
                "NetworkSettings": {"Networks": {"windmill_default": {"Aliases": [service, f"windmill-{service}-1"]}}}}
        with socket.socket() as reserved:
            reserved.bind(("127.0.0.1", 0))
            port = reserved.getsockname()[1]
        tools = {name: shutil.which(name) for name in ("psql", "pg_dump", "pg_restore", "sha256sum", "shasum", "curl")}
        state = {"containers": containers, "commands": [], "toolCalls": [], "events": [], "migrationTools": [],
                 "productionRuntime": production_env,
                 "databaseUrl": self.database_url(database), "databaseName": database, "maintenanceDb": self.args.maintenance_db,
                 "postgresUser": self.postgres_user, "binDir": str(self.args.bin_dir), "workDir": str(work),
                 "imageCompatibility": "gym-journal-v1", "serverPort": port, "tools": tools, "realPath": os.environ["PATH"],
                 "composeConfig": {"services": {service: {"image": IMAGE, "restart": "no" if service == "migrate" else "unless-stopped"}
                                                for service in services if service != "orphan-writer"}}, **injection}
        state_path = work.parent / "docker-state.json"
        state_path.write_text(json.dumps(state))
        self.states.append(state_path)
        binaries = work.parent / "bin"
        binaries.mkdir()
        for tool, mode in [("docker", "--docker-shim"), *[(name, "--tool-shim " + name) for name in tools if tools[name]]]:
            path = binaries / tool
            path.write_text("#!/bin/sh\nexec " + shlex.join([sys.executable, str(SELF)]) + " " + mode + ' "$@"\n')
            path.chmod(0o700)
        environment = {**os.environ, **SWITCHES, "LEGACY_REST_WRITES_RETIRED": "0", "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                       "WM_CUTOVER_STATE": str(state_path)}
        return work, state_path, environment, database

    def execute(self, fixture, script=SCRIPT):
        work, state_path, environment, _ = fixture
        output, errors = work.parent / "stdout", work.parent / "stderr"
        # Keep concurrent worktree edits out of Bash's unread program bytes.
        executable = work.parent / "script-under-test.sh"
        shutil.copyfile(script, executable)
        with output.open("wb") as stdout, errors.open("wb") as stderr:
            process = subprocess.Popen(["bash", str(executable), *([str(work)] if script == SCRIPT else [])], cwd=work,
                env=environment, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
            # The script's first shim call can already be reading state; write it as the shims do.
            with Path(str(state_path) + ".lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                state = json.loads(state_path.read_text())
                state["scriptPid"] = process.pid
                temporary = Path(str(state_path) + ".pid.tmp")
                temporary.write_text(json.dumps(state))
                os.replace(temporary, state_path)
            try:
                status = process.wait(timeout=240)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                raise AssertionError("cutover timed out: " + output.read_text() + errors.read_text())
        text = output.read_bytes() + errors.read_bytes()
        assert SECRET.encode() not in text and b"example.invalid" not in text, text
        self.cases += 1
        return status, output.read_bytes(), errors.read_bytes(), json.loads(state_path.read_text())

    def assert_old_running(self, original, state):
        differences = {identifier: [key for key in row if row[key] != state["containers"][identifier][key]]
                       for identifier, row in original.items() if row != state["containers"][identifier]}
        assert not differences, "failed pre-traffic cutover did not resume exact original containers/configuration: " + str(differences)
        assert "started-engine" not in state["events"], state["events"]

    def verify_backup(self, fixture, checksum_required=True):
        work, _, _, database = fixture
        dumps = sorted((work / "migration-evidence").glob("products-cutover-*/rollback.dump"))
        if not dumps and not checksum_required:
            dumps = sorted((work / "migration-evidence").glob("products-cutover-*/rollback.dump.partial"))
        assert dumps, "backup missing"
        dump = dumps[-1]
        command(["pg_restore", "--list", str(dump)])
        digest = hashlib.sha256(dump.read_bytes()).hexdigest()
        if checksum_required:
            assert digest in Path(str(dump) + ".sha256").read_text(), "backup checksum mismatch"
        clone = self.create_database()
        command(["pg_restore", "--dbname", self.database_url(clone), "--no-owner", "--no-privileges", "--exit-on-error", str(dump)])
        assert self.snapshot(clone) == self.snapshot(database), "restored production differs from actual rollback backup rows/schema/sequences"
        return dump, digest

    def success(self):
        fixture = self.fixture("success")
        status, output, errors, state = self.execute(fixture)
        assert status == 0 and output.startswith(b"PASS") and not errors, (status, output, errors)
        assert self.adopted(fixture[3]), "successful cutover did not adopt both products"
        report = json.loads((Path(state["migrationEvidence"]) / "run/result.json").read_text())
        assert report["passed"] and report["corruptionsRejected"] == 0 and not report["journalBeforeCommitInterruption"], report
        assert report["bootstrapCatalogUnchanged"] and report["gymBootstrapUnchanged"] and report["journalBootstrapUnchanged"], report
        assert env_file(fixture[0] / ".env") | SWITCHES == env_file(fixture[0] / ".env"), "engine switches were not rendered"
        assert {"windmill_gym_backfill", "windmill_journal_backfill"} <= {
            args[4] for args in state["commands"] if args[:4] == ["compose", "exec", "-T", "server"] and len(args) == 6
            and args[-1] == "--audit-current"}, state["commands"]
        assert "started-engine" in state["events"] and "restored" not in state["events"], state["events"]
        for row in state["containers"].values():
            service = row["Config"]["Labels"]["com.docker.compose.service"]
            assert row["State"]["Running"] == (service not in ("migrate", "orphan-writer")), service
        evidence = Path(state["migrationEvidence"])
        dump = evidence / "rollback.dump"
        assert str(dump).encode() in output and hashlib.sha256(dump.read_bytes()).hexdigest().encode() in output, output
        for path in evidence.rglob("*"):
            assert stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, path
        self.stop_server(fixture[1])
        return fixture

    def legacy_retirement(self):
        # Read the registration mark rather than maintaining a second list of retired paths.
        inventory = []
        for product in ("gym", "journal"):
            source = (BACKEND / f"products/{product}/routes.cpp").read_text()
            inventory += re.findall(
                r'routes\.(register(?:LegacyWrite)?Handler)\(\s*"([^"]+)"'
                r'(?:(?!routes\.register(?:LegacyWrite)?Handler).)*?'
                r'\{drogon::(Get|Post|Put|Patch|Delete)\}\)', source, re.DOTALL)
        retired = [(path, method.upper()) for registrar, path, method in inventory
                   if registrar == "registerLegacyWriteHandler"]
        assert retired and any(path.startswith("/v1/journal/") for path, _ in retired), "retirement inventory missing a product"
        expected = {"error": "This version of the app can no longer save; update it.",
                    "code": "client-update-required"}
        for engine, frozen in (("0", "0"), ("1", "0"), ("1", "1")):
            database = self.create_database(self.template)
            self.apply(database, "gym_sync.sql", "journal_sync.sql")
            for product in ("gym", "journal"):
                command([self.args.bin_dir / f"windmill_{product}_backfill"],
                        {**os.environ, **OLD_SWITCHES, "DATABASE_URL": self.database_url(database)})
            owner = self.sql(database, "SELECT id FROM users WHERE email='gym-rehearsal-1@example.invalid'").decode()
            digest = hashlib.sha256(SECRET.encode()).hexdigest()
            self.sql(database, f"INSERT INTO sessions(token_hash,user_id,expires_ms) "
                     f"VALUES ('{digest}','{owner}',99999999999999)")
            with socket.socket() as reserved:
                reserved.bind(("127.0.0.1", 0))
                port = reserved.getsockname()[1]
            environment = {**os.environ, **SWITCHES, "DATABASE_URL": self.database_url(database), "PORT": str(port),
                "LEGACY_REST_WRITES_RETIRED": "1", "GYM_ENGINE_WRITES": engine, "JOURNAL_ENGINE_WRITES": engine,
                "GYM_WRITE_FREEZE": frozen, "JOURNAL_WRITE_FREEZE": frozen, "SYNC_ENABLED": engine,
                "WINDMILL_HOST": "127.0.0.1", "WINDMILL_APP_URL": "http://cutover.test",
                "WINDMILL_API_URL": "http://cutover.test", "WINDMILL_COOKIE_DOMAIN": "",
                "WINDMILL_MCP_TOKEN": SECRET, "WINDMILL_MCP_USER": owner, "WINDMILL_MCP_PATH": "/mcp",
                "ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": "", "RESEND_API_KEY": "", "SENTRY_DSN": "",
                "AMPLITUDE_API_KEY": "", "JOURNAL_EMBEDDER_URL": "", "JOURNAL_NUDGE_ENABLED": "0",
                "REMINDERS_ENABLED": "0", "TENDING_ENABLED": "0"}
            log = self.directory / f"legacy-retirement-{engine}-{frozen}.log"
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)

            def request(method, path, body=b"{}", headers=None):
                connection.request(method, path, body, {"Content-Type": "application/json", **(headers or {})})
                response = connection.getresponse()
                return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()

            def concrete(path):
                return re.sub(r'\{([^}]+)\}', lambda match: "2026-09-01"
                              if match[1] in ("date", "dateLocal", "day", "triggerDay", "matchDay")
                              else "retirement_fixture", path)

            cookie = {"Cookie": "wm_session=" + SECRET}
            with log.open("wb") as output:
                process = subprocess.Popen([str(self.args.bin_dir / "windmill_server")], cwd=self.directory,
                    env=environment, stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
            try:
                deadline = time.monotonic() + 15
                while True:
                    if process.poll() is not None:
                        raise AssertionError("retirement server exited during startup: " + log.read_text())
                    try:
                        status, _, _ = request("GET", "/v1/gym/preferences")
                        assert status == 401, ("read startup probe", status)
                        break
                    except (OSError, http.client.HTTPException):
                        connection.close()
                        if time.monotonic() >= deadline:
                            raise AssertionError("retirement server startup timed out: " + log.read_text())
                        time.sleep(0.05)
                baseline = self.snapshot(database, row_versions=True)
                for path, method in retired:
                    for body, headers in ((b"{}", {}), (b"{", cookie),
                                          (b'{"title":"Retired","body":"Must not be saved"}', cookie)):
                        status, fields, payload = request(method, concrete(path), body, headers)
                        assert status == 410 and json.loads(payload) == expected, (method, path, status, payload)
                        assert fields.get("content-type", "").startswith("application/json"), fields
                # Drain the ordinary visitor bucket, then prove retirement still wins.
                forwarded = {"X-Forwarded-For": "192.0.2.17"}
                for _ in range(100):
                    status, _, _ = request("GET", "/v1/gym/preferences", b"", forwarded)
                    if status == 429:
                        break
                    assert status == 401, ("retained rate-limit control", status)
                else:
                    raise AssertionError("retained route did not enforce its 50-request rate-limit burst")
                for _ in range(100):
                    path, method = retired[0]
                    status, _, payload = request(method, concrete(path), b"", {**cookie, **forwarded})
                    assert status == 410 and json.loads(payload) == expected, ("rate limited retirement", status, payload)
                assert self.snapshot(database, row_versions=True) == baseline, "retired requests touched database rows/schema/sequences"

                # Every retained registration reaches its existing door; public/conditional reads
                # and the unconfigured Ask path may answer 404, but none may answer retirement.
                for registrar, path, method in inventory:
                    if registrar == "registerLegacyWriteHandler":
                        continue
                    status, _, payload = request(method.upper(), concrete(path))
                    assert status != 410, ("retained route retired", method, path, payload)
                for path in ("/v1/gym/preferences", "/v1/journal/pages"):
                    status, _, payload = request("GET", path, headers=cookie)
                    assert status == 200, ("retained authenticated read", path, status, payload)
                if frozen == "0":
                    status, _, payload = request("PATCH", "/v1/journal/nudge", b'{"enabled":false}', cookie)
                    assert status == 200 and not json.loads(payload)["enabled"], (status, payload)
                    assert self.sql(database, f"SELECT NOT enabled FROM journal_nudge WHERE user_id='{owner}'") == b"t"
                    mcp = {"Authorization": "Bearer " + SECRET}
                    status, fields, payload = request("POST", "/mcp", json.dumps({"jsonrpc": "2.0", "id": "init",
                        "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                        "clientInfo": {"name": "retirement-test", "version": "1"}}}).encode(), mcp)
                    assert status == 200 and "result" in json.loads(payload), (status, payload)
                    mcp["Mcp-Session-Id"] = fields["mcp-session-id"]
                    status, _, payload = request("POST", "/mcp", json.dumps({"jsonrpc": "2.0", "id": "write",
                        "method": "tools/call", "params": {"name": "gym_save_note", "arguments": {
                        "id": "note_retirement_mcp", "title": "MCP retained", "body": "Saved through the tool door."}}}).encode(), mcp)
                    reply = json.loads(payload)
                    assert status == 200 and "result" in reply and not reply["result"].get("isError", False), (status, payload)
                    assert self.sql(database, f"SELECT body FROM gym_notes WHERE user_id='{owner}' AND id='note_retirement_mcp'") == b"Saved through the tool door."
                self.cases += 1
                print(f"PASS legacy retirement engine={engine} freeze={frozen}: {len(retired)} routes, no data touched", flush=True)
            finally:
                connection.close()
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)

    def failures(self):
        for phase in ("dump", "list", "checksum", "schema", "journal-schema", "backfill", "journal-backfill",
                      "audit", "journal-audit", "bootstrap", "gym-bootstrap-audit", "journal-bootstrap-audit", "prepare"):
            fixture = self.fixture("failure-" + phase, failAt=phase)
            original = copy.deepcopy(json.loads(fixture[1].read_text())["containers"])
            baseline = self.snapshot(fixture[3])
            original_env = (fixture[0] / ".env").read_bytes()
            status, output, errors, state = self.execute(fixture)
            assert status != 0 and output.startswith(b"FAIL") and not errors, (phase, status, output, errors)
            assert state.get("injectionFired"), (phase, state["events"])
            assert not self.adopted(fixture[3]), phase
            assert self.snapshot(fixture[3]) == baseline, "failed " + phase + " changed production rows/schema/sequences"
            assert (fixture[0] / ".env").read_bytes() == original_env, phase
            self.assert_old_running(original, state)
            if phase not in ("dump", "list", "checksum"):
                assert "restored" in state["events"], (phase, state["events"])
                self.verify_backup(fixture)
            else:
                self.verify_backup(fixture, checksum_required=False)
            print("PASS pre-traffic rollback " + phase, flush=True)

    def kills(self):
        for phase in ("precondition", "stop", "backup", "verified-backup", "schema", "journal-schema",
                      "backfill", "journal-backfill", "audit", "journal-audit", "bootstrap", "prepare", "start", "smoke"):
            fixture = self.fixture("kill-" + phase, killAt=phase)
            status, output, errors, state = self.execute(fixture)
            assert status == -signal.SIGKILL and state.get("injectionFired"), (phase, status, output, errors, state["events"])
            before = self.snapshot(fixture[3])
            adopted = self.adopted(fixture[3])
            old_env = (fixture[0] / ".env").read_bytes()
            state.pop("killAt", None)
            state.pop("injectionEvent", None)
            state.pop("injectionFired", None)
            state.pop("killFired", None)
            state.pop("failFired", None)
            fixture[1].write_text(json.dumps(state))
            status, output, errors, state = self.execute(fixture)
            assert not errors, (phase, errors)
            if adopted:
                assert status != 0 and output.startswith(b"FAIL"), (phase, status, output)
                assert b"adopt" in output.lower() and any(word in output.lower() for word in (b"forward", b"manual", b"inspect", b"instruction")), output
                assert self.snapshot(fixture[3]) == before and (fixture[0] / ".env").read_bytes() == old_env, phase
                assert "restored" not in state["events"], (phase, state["events"])
            else:
                assert status == 0 and output.startswith(b"PASS") and self.adopted(fixture[3]), (phase, status, output)
            self.stop_server(fixture[1])
            print("PASS SIGKILL/re-run " + phase + (" adopted refusal" if adopted else " safe retry"), flush=True)

    def recovery_restore_kill(self):
        fixture = self.fixture("kill-previous-backup-restore", killAt="verified-backup")
        baseline = self.snapshot(fixture[3])
        status, output, errors, state = self.execute(fixture)
        assert status == -signal.SIGKILL and state.get("killFired"), (status, output, errors)
        for key in ("killAt", "injectionEvent", "injectionFired", "killFired"):
            state.pop(key, None)
        state["killAt"] = "recovery-restore"
        fixture[1].write_text(json.dumps(state))
        status, output, errors, state = self.execute(fixture)
        assert status == -signal.SIGKILL and state.get("killFired"), (status, output, errors, state["events"])
        assert state.get("realRestoreBlocked"), "SIGKILL did not interrupt a live pg_restore"
        for key in ("killAt", "injectionEvent", "injectionFired", "killFired"):
            state.pop(key, None)
        fixture[1].write_text(json.dumps(state))
        # Fail a new dump after recovery to expose an incorrectly accepted partial restore.
        state["failAt"] = "dump"
        fixture[1].write_text(json.dumps(state))
        status, output, errors, state = self.execute(fixture)
        assert status != 0 and output.startswith(b"FAIL") and not errors and state.get("failFired"), (status, output, errors)
        assert self.snapshot(fixture[3]) == baseline, "third invocation lost the original rollback archive during interrupted restore"
        assert not self.adopted(fixture[3]), "partial recovery unexpectedly adopted production"
        print("PASS SIGKILL during previous-backup restore retains original archive", flush=True)

    def automatic_restore_kill(self):
        fixture = self.fixture("kill-first-automatic-restore", failAt="prepare", killAt="recovery-restore")
        baseline = self.snapshot(fixture[3])
        original = copy.deepcopy(json.loads(fixture[1].read_text())["containers"])
        original_env = (fixture[0] / ".env").read_bytes()
        status, output, errors, state = self.execute(fixture)
        assert status == -signal.SIGKILL and state.get("killFired") and state.get("failFired"), (status, output, errors)
        assert state.get("realRestoreBlocked"), "first automatic rollback did not interrupt a live pg_restore"
        evidence = Path((fixture[0] / "migration-evidence/active-cutover").read_text().strip())
        assert (evidence / "phase").read_text().strip() == "restoring", "automatic rollback did not persist restoring"
        assert env_file(fixture[0] / ".env")["JOURNAL_ENGINE_WRITES"] == "1", "kill did not retain prepared environment"
        archive = (evidence / "rollback.dump").read_bytes()
        for key in ("killAt", "injectionEvent", "injectionFired", "killFired", "failFired"):
            state.pop(key, None)
        # Stop after restoring, before a new archive could hide an incomplete recovery.
        state["failAt"] = "dump"
        fixture[1].write_text(json.dumps(state))
        status, output, errors, state = self.execute(fixture)
        assert status != 0 and output.startswith(b"FAIL") and not errors and state.get("failFired"), (status, output, errors)
        assert (evidence / "rollback.dump").read_bytes() == archive, "rerun replaced the interrupted restore's archive"
        assert self.snapshot(fixture[3]) == baseline, "automatic rollback retry lost rows/schema/sequences"
        assert (fixture[0] / ".env").read_bytes() == original_env, "automatic rollback retry did not restore legacy switches"
        self.assert_old_running(original, state)
        print("PASS SIGKILL during first automatic rollback resumes verified archive", flush=True)

        fixture = self.fixture("kill-automatic-restore-before-start", failAt="prepare", killAt="automatic-restore-before-start")
        baseline = self.snapshot(fixture[3])
        status, output, errors, state = self.execute(fixture)
        assert status == -signal.SIGKILL and state.get("killFired") and state.get("failFired"), (status, output, errors)
        evidence = Path((fixture[0] / "migration-evidence/active-cutover").read_text().strip())
        assert (evidence / "phase").read_text().strip() == "restoring" and self.adopted(fixture[3]), "kill did not preserve adopted restore input"
        for key in ("killAt", "injectionEvent", "injectionFired", "killFired", "failFired"):
            state.pop(key, None)
        state["failAt"] = "dump"
        fixture[1].write_text(json.dumps(state))
        status, output, errors, state = self.execute(fixture)
        assert status != 0 and output.startswith(b"FAIL") and not errors and state.get("failFired"), (status, output, errors)
        assert self.snapshot(fixture[3]) == baseline, "restoring state refused the archive while adoption objects remained"
        assert not self.adopted(fixture[3]), "recovery retained adoption objects"
        print("PASS SIGKILL before automatic restore resumes despite adoption objects", flush=True)

    def rollback_start_kill(self):
        fixture = self.fixture("kill-rollback-old-start", failAt="schema", killAt="old-start")
        status, output, errors, state = self.execute(fixture)
        assert status == -signal.SIGKILL and state.get("killFired") and state.get("failFired"), (status, output, errors)
        assert not self.adopted(fixture[3]) and "restored" in state["events"], state["events"]
        owner = self.sql(fixture[3], "SELECT id FROM users ORDER BY id LIMIT 1").decode()
        self.sql(fixture[3], f"INSERT INTO journal_page(user_id,day,body) VALUES ('{owner}','2099-01-01','accepted after recovery')")
        restores = state["events"].count("restored")
        for key in ("failAt", "killAt", "injectionEvent", "injectionFired", "killFired", "failFired"):
            state.pop(key, None)
        fixture[1].write_text(json.dumps(state))
        status, output, errors, state = self.execute(fixture)
        assert status == 0 and output.startswith(b"PASS") and not errors, (status, output, errors)
        assert state["events"].count("restored") == restores, "retry restored an obsolete backup after old traffic resumed"
        assert self.sql(fixture[3], f"SELECT body FROM journal_page WHERE user_id='{owner}' AND day='2099-01-01'") == b"accepted after recovery", "retry lost newly accepted legacy write"
        self.stop_server(fixture[1])
        print("PASS SIGKILL during rollback startup preserves resumed legacy writes", flush=True)

    def forward_only(self):
        for phase in ("start", "smoke"):
            fixture = self.fixture("forward-only-" + phase, failAt=phase)
            status, output, errors, state = self.execute(fixture)
            assert status != 0 and output.startswith(b"FAIL") and not errors, (status, output, errors)
            assert state.get("injectionFired") and self.adopted(fixture[3]), phase
            assert b"forward-only" in output.lower() and "restored" not in state["events"], output
            assert env_file(fixture[0] / ".env").get("GYM_ENGINE_WRITES") == "1", phase
            assert "started-engine" in state["events"], state["events"]
            self.stop_server(fixture[1])

    def guards(self):
        for key, value in SWITCHES.items():
            for wrong in (("1",) if key == "SYNC_ENABLED" else (None, "0" if value == "1" else "1")):
                fixture = self.fixture("guard-" + key + str(wrong))
                original = copy.deepcopy(json.loads(fixture[1].read_text())["containers"])
                if wrong is None:
                    fixture[2].pop(key, None)
                else:
                    fixture[2][key] = wrong
                status, output, _, state = self.execute(fixture)
                assert status != 0 and output.startswith(b"FAIL"), (key, wrong, output)
                assert state["containers"] == original, key
        for marker in (None, "legacy-v0"):
            fixture = self.fixture("guard-image-" + str(marker), imageCompatibility=marker)
            original = copy.deepcopy(json.loads(fixture[1].read_text())["containers"])
            status, output, _, state = self.execute(fixture)
            assert status != 0 and output.startswith(b"FAIL") and state["containers"] == original, output
        for kind, source in {"function": "CREATE FUNCTION wm_journal_rehearsal_pause_stale() RETURNS void LANGUAGE sql AS $$SELECT$$",
                             "table": "CREATE TABLE wm_journal_rehearsal_pause_stale(value text)",
                             "trigger": "CREATE FUNCTION unrelated_test_trigger() RETURNS trigger LANGUAGE plpgsql "
                             "AS $$BEGIN RETURN NULL; END$$; CREATE TRIGGER wm_journal_rehearsal_pause_stale BEFORE UPDATE ON journal_page "
                             "FOR EACH STATEMENT EXECUTE FUNCTION unrelated_test_trigger()"}.items():
            fixture = self.fixture("guard-fixture-" + kind)
            self.sql(fixture[3], source)
            baseline = self.snapshot(fixture[3])
            original = copy.deepcopy(json.loads(fixture[1].read_text())["containers"])
            status, output, _, state = self.execute(fixture)
            assert status != 0 and output.startswith(b"FAIL") and state["containers"] == original, output
            assert self.snapshot(fixture[3]) == baseline, "precondition modified " + kind + " fixture object"
        for phase in ("complete", "forward-only"):
            fixture = self.fixture("guard-forward-record-" + phase, imageCompatibility=None)
            work = fixture[0]
            evidence = work / "migration-evidence" / "previous-cutover"
            evidence.mkdir(parents=True)
            (evidence / "phase").write_text(phase + "\n")
            archive = evidence / "rollback.dump"
            archive.write_bytes(b"previous-private-archive")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            Path(str(archive) + ".sha256").write_text(digest + "  " + str(archive) + "\n")
            (evidence.parent / "active-cutover").write_text(str(evidence) + "\n")
            state = json.loads(fixture[1].read_text())
            state["containers"] = {}
            fixture[1].write_text(json.dumps(state))
            (work / ".env").unlink()
            baseline = self.snapshot(fixture[3])
            status, output, errors, state = self.execute(fixture)
            assert status != 0 and output.startswith(b"FAIL") and not errors, (phase, status, output, errors)
            assert b"forward-only" in output and b"repair" in output, output
            assert str(archive).encode() in output and digest.encode() in output, output
            assert state["commands"] == [["compose", "version"]] and not state["toolCalls"], "forward-only rerun inspected a missing runtime"
            assert self.snapshot(fixture[3]) == baseline, "forward-only rerun changed production"

    def deploy_guards(self):
        for adopted, gym_writes, journal_writes, incomplete in ((False, "1", "0", False), (False, "0", "1", False),
                (False, "true", "0", False), (False, "on", "0", False), (False, "0", "true", False),
                (False, "0", "on", False), (False, "1", "1", False), (True, "0", "0", False),
                (True, "1", "0", False), (True, "0", "1", False),
                (True, "1", "1", True), (True, "true", "on", True), (True, "on", "true", False)):
            fixture = self.fixture("deploy-" + str(adopted) + gym_writes + journal_writes + str(incomplete),
                                   imageCompatibility=None if gym_writes == "on" and adopted else "gym-journal-v1")
            if adopted:
                self.apply(fixture[3], "gym_sync.sql", "journal_sync.sql")
                if not incomplete:
                    for product in ("gym", "journal"):
                        command([self.args.bin_dir / f"windmill_{product}_backfill"],
                                {**os.environ, "DATABASE_URL": self.database_url(fixture[3])})
            work = fixture[0]
            for key in SWITCHES:
                fixture[2].pop(key, None)
            (work / "rendered.env").write_text((work / ".env").read_text() +
                f"GYM_ENGINE_WRITES={gym_writes}\nJOURNAL_ENGINE_WRITES={journal_writes}\n")
            shutil.copyfile(work / "docker-compose.yml", work / "docker-compose.next.yml")
            shutil.copyfile(work / "Caddyfile", work / "Caddyfile.next")
            live_files = {name: (work / name).read_bytes() for name in (".env", "docker-compose.yml", "Caddyfile")}
            original = copy.deepcopy(json.loads(fixture[1].read_text())["containers"])
            baseline = self.snapshot(fixture[3])
            status, output, errors, state = self.execute(fixture, BACKEND / "deploy/deploy-production.sh")
            assert status != 0, (adopted, status, output, errors)
            expected = (b"adoption" if incomplete else b"adoption-compatible image" if adopted and gym_writes == "on"
                        else b"requires both" if adopted else b"complete product adoption")
            assert expected in (output + errors), (output, errors)
            assert all((work / name).read_bytes() == content for name, content in live_files.items()), "refused deploy changed live files"
            assert state["containers"] == original, "refused deploy stopped/recreated old containers"
            assert self.snapshot(fixture[3]) == baseline, "refused deploy changed production"
            assert not any(args[0] in ("stop", "start", "update") or (args[0] == "compose" and "up" in args)
                           for args in state["commands"]), state["commands"]

        for phase in ("migration", "prepare", "complete", "rolled-back", "forward-only"):
            adopted = phase != "rolled-back"
            fixture = self.fixture("deploy-recorded-" + phase)
            if adopted:
                self.apply(fixture[3], "gym_sync.sql", "journal_sync.sql")
                for product in ("gym", "journal"):
                    command([self.args.bin_dir / f"windmill_{product}_backfill"],
                            {**os.environ, "DATABASE_URL": self.database_url(fixture[3])})
                if phase == "complete":
                    self.sql(fixture[3], "INSERT INTO users(id,email) VALUES "
                        "('20000000-0000-4000-8000-000000000009','fresh-empty-user@cutover.test')")
            work = fixture[0]
            for key in SWITCHES:
                fixture[2].pop(key, None)
            switches = SWITCHES if adopted else OLD_SWITCHES
            (work / "rendered.env").write_text((work / ".env").read_text() +
                "".join(f"{key}={value}\n" for key, value in switches.items()))
            shutil.copyfile(work / "docker-compose.yml", work / "docker-compose.next.yml")
            shutil.copyfile(work / "Caddyfile", work / "Caddyfile.next")
            evidence = work / "migration-evidence" / "previous-cutover"
            evidence.mkdir(parents=True)
            (evidence / "phase").write_text(phase + "\n")
            (evidence.parent / "active-cutover").write_text(str(evidence) + "\n")
            state = json.loads(fixture[1].read_text())
            if phase in ("migration", "prepare"):
                for row in state["containers"].values():
                    if row["Config"]["Labels"]["com.docker.compose.service"] != "db":
                        row["State"]["Running"] = False
                        row["HostConfig"]["RestartPolicy"]["Name"] = "no"
            fixture[1].write_text(json.dumps(state))
            original = copy.deepcopy(state["containers"])
            live_files = {name: (work / name).read_bytes() for name in (".env", "docker-compose.yml", "Caddyfile")}
            baseline = self.snapshot(fixture[3])
            status, output, errors, state = self.execute(fixture, BACKEND / "deploy/deploy-production.sh")
            if phase in ("migration", "prepare"):
                assert status != 0 and b"cutover" in output + errors, (phase, status, output, errors)
                assert state["containers"] == original, "interrupted cutover deploy resumed stopped services"
                assert all((work / name).read_bytes() == content for name, content in live_files.items()), phase
                assert self.snapshot(fixture[3]) == baseline, "interrupted cutover deploy changed production"
            else:
                assert status == 0 and b"PASS deployed:" in output, (phase, status, output, errors)
                if adopted:
                    assert b'"audit":true' in output, "deploy discarded healthy online audit diagnostics"
                assert env_file(work / ".env").items() >= switches.items(), phase
                assert ("started-engine" if adopted else "started-old") in state["events"], state["events"]
                assert "restored" not in state["events"], "deploy restored a cutover backup"
                self.stop_server(fixture[1])

        for failure in (None, "caddyStaleMount", "caddyStaleConfig"):
            fixture = self.fixture("deploy-caddy-" + str(failure))
            work = fixture[0]
            for key in SWITCHES:
                fixture[2].pop(key, None)
            shutil.copyfile(work / ".env", work / "rendered.env")
            shutil.copyfile(work / "docker-compose.yml", work / "docker-compose.next.yml")
            old = (work / "Caddyfile").read_text()
            (work / "Caddyfile.next").write_text(old + "\n# changed config\n")
            state = json.loads(fixture[1].read_text())
            state.update(caddyFile=old, caddyActive={"file": old})
            if failure:
                state[failure] = True
            fixture[1].write_text(json.dumps(state))
            status, output, errors, state = self.execute(fixture, BACKEND / "deploy/deploy-production.sh")
            assert (status == 0) == (failure is None), (failure, status, output, errors)
            assert any("--force-recreate" in args and args[-1] == "caddy" for args in state["commands"])
            if failure is None:
                assert state["caddyFile"] == (work / "Caddyfile").read_text()
                assert state["caddyActive"] == {"file": state["caddyFile"]}

        fixture = self.fixture("deploy-caddy-interrupted", killAt="deploy-promoted")
        work = fixture[0]
        for key in SWITCHES:
            fixture[2].pop(key, None)
        old = (work / "Caddyfile").read_text()
        intended = old + "\n# retry configuration\n"
        state = json.loads(fixture[1].read_text())
        state.update(caddyFile=old, caddyActive={"file": old})
        fixture[1].write_text(json.dumps(state))
        for attempt in range(2):
            shutil.copyfile(work / ".env", work / "rendered.env")
            shutil.copyfile(work / "docker-compose.yml", work / "docker-compose.next.yml")
            (work / "Caddyfile.next").write_text(intended)
            status, output, errors, state = self.execute(fixture, BACKEND / "deploy/deploy-production.sh")
            if attempt == 0:
                assert status == -signal.SIGKILL and state.get("killFired"), (status, output, errors)
                assert (work / "Caddyfile").read_text() == intended and state["caddyFile"] == old, state
                assert state["caddyActive"] == {"file": old}, "kill did not precede Caddy recreation"
                for key in ("killAt", "injectionEvent", "injectionFired", "killFired"):
                    state.pop(key, None)
                fixture[1].write_text(json.dumps(state))
            else:
                assert status == 0 and b"PASS deployed:" in output, (status, output, errors)
                assert state["caddyFile"] == intended and state["caddyActive"] == {"file": intended}, state
                assert any("--force-recreate" in args and args[-1] == "caddy" for args in state["commands"])
        print("PASS interrupted Caddy promotion heals on same-candidate retry", flush=True)

        for product in ("gym", "journal"):
            fixture = self.fixture("deploy-corrupted-digest-" + product)
            work = fixture[0]
            self.apply(fixture[3], "gym_sync.sql", "journal_sync.sql")
            for adopted_product in ("gym", "journal"):
                command([self.args.bin_dir / f"windmill_{adopted_product}_backfill"],
                        {**os.environ, "DATABASE_URL": self.database_url(fixture[3])})
            self.sql(fixture[3], "UPDATE sync_scopes SET digest=decode(repeat('00',32),'hex') "
                     f"WHERE key LIKE '%/{product}'")
            for key in SWITCHES:
                fixture[2].pop(key, None)
            (work / "rendered.env").write_text((work / ".env").read_text() +
                "".join(f"{key}={value}\n" for key, value in SWITCHES.items()))
            shutil.copyfile(work / "docker-compose.yml", work / "docker-compose.next.yml")
            shutil.copyfile(work / "Caddyfile", work / "Caddyfile.next")
            original = copy.deepcopy(json.loads(fixture[1].read_text())["containers"])
            files = {name: (work / name).read_bytes() for name in (".env", "docker-compose.yml", "Caddyfile")}
            baseline = self.snapshot(fixture[3])
            status, output, errors, state = self.execute(fixture, BACKEND / "deploy/deploy-production.sh")
            assert status != 0 and b"current feed digest or greatest seq mismatch" in errors, (status, output, errors)
            assert b"current audit failed" in errors, errors
            assert state["containers"] == original and self.snapshot(fixture[3]) == baseline, "corrupt audit refusal changed production"
            assert all((work / name).read_bytes() == content for name, content in files.items()), "corrupt audit refusal promoted files"
        print("PASS deploy preserves content-free corruption diagnostics for both products", flush=True)

    def prerequisites(self):
        for script in (SCRIPT, BACKEND / "deploy/deploy-production.sh"):
            for missing in ("python3", "sha256sum", "docker", "docker compose"):
                fixture = self.fixture("prerequisite-" + script.stem + "-" + missing.replace(" ", "-"))
                work, state_path, environment, database = fixture
                limited = work.parent / "prerequisite-bin"
                limited.mkdir()
                for tool in ("bash", "python3", "sha256sum", "docker"):
                    if tool != missing:
                        target = work.parent / "bin" / tool if tool == "docker" else Path(shutil.which(tool))
                        (limited / tool).symlink_to(target)
                environment["PATH"] = str(limited)
                state = json.loads(state_path.read_text())
                state["composeUnavailable"] = missing == "docker compose"
                state_path.write_text(json.dumps(state))
                original = copy.deepcopy(state["containers"])
                baseline = self.snapshot(database)
                files = {path.relative_to(work): path.read_bytes() for path in work.rglob("*") if path.is_file()}
                status, output, errors, state = self.execute(fixture, script)
                expected = ("FAIL required host command missing: " + missing if missing in ("python3", "sha256sum")
                            else "FAIL required host command unavailable: docker compose")
                assert status != 0 and output + errors == (expected + "\n").encode(), (status, output, errors)
                assert files == {path.relative_to(work): path.read_bytes() for path in work.rglob("*") if path.is_file()}, "prerequisite refusal changed files"
                assert state["containers"] == original and not state["toolCalls"], "prerequisite refusal changed runtime"
                assert self.snapshot(database) == baseline, "prerequisite refusal changed database"
        print("PASS both scripts refuse missing host prerequisites before changes", flush=True)

    def workflows(self):
        source = self.args.cutover_workflow.read_text()
        assert "workflow_dispatch:" in source and "workflow_run:" not in source and "push:" not in source, source
        assert "group: deploy-vps" in source and "cancel-in-progress: false" in source, source
        assert "cut over gym and journal" in source and "inputs.confirm" in source, source
        assert "cutover-production.sh" in source and "migrate-production.sh" not in source, source
        deploy = self.args.deploy_workflow.read_text()
        assert "group: deploy-vps" in deploy
        assert "deploy-production.sh" in deploy, "deploy tests must exercise the program actually shipped by deploy.yml"
        assert "LEGACY_REST_WRITES_RETIRED: ${{ vars.LEGACY_REST_WRITES_RETIRED || '0' }}" in deploy, "retirement switch must default off in deploy"
        render_keys = re.search(r'for key in POSTGRES_PASSWORD ([\s\S]*?); do', deploy)
        assert render_keys and "LEGACY_REST_WRITES_RETIRED" in render_keys[1].split(), "deploy must forward retirement switch to .env"
        compose = (BACKEND / "deploy/docker-compose.yml").read_text()
        assert "LEGACY_REST_WRITES_RETIRED: ${LEGACY_REST_WRITES_RETIRED:-0}" in compose, "compose must forward retirement switch and default off"
        assert not (BACKEND / "deploy/gym-migration/database-fence.sh").exists(), "obsolete database fence remains"
        assert not (BACKEND / "deploy/gym-migration/migrate-production.sh").exists(), "obsolete fenced migration remains"
        self.cases += 1

    def stop_server(self, state_path):
        state = json.loads(state_path.read_text())
        for field in ("serverProcessGroup", "migrationProcessGroup"):
            if state.get(field):
                try:
                    os.killpg(state[field], signal.SIGKILL)
                except ProcessLookupError:
                    pass
                state.pop(field, None)
        state_path.write_text(json.dumps(state))

    def cleanup(self):
        for state in self.states:
            self.stop_server(state)
        for database in reversed(self.databases):
            command(["dropdb", "--force", "--if-exists", "--maintenance-db=" + self.args.maintenance_db, database])


def main():
    parser = argparse.ArgumentParser(description="Test production cutover with real PostgreSQL and modeled Docker")
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--maintenance-db", default=os.environ.get("DATABASE_URL", "postgresql:///postgres?host=/tmp"))
    parser.add_argument("--deploy-workflow", type=Path, default=BACKEND.parent / ".github/workflows/deploy.yml")
    parser.add_argument("--cutover-workflow", type=Path, default=BACKEND.parent / ".github/workflows/products-cutover.yml")
    parser.add_argument("--regression-only", choices=("success", "failures", "kills", "guards", "deploy-guards", "forward-only", "rollback-kill", "recovery-kill", "automatic-restore-kill", "prerequisites", "legacy-retirement"))
    args = parser.parse_args()
    args.bin_dir = args.bin_dir.resolve()
    for product in ("gym", "journal"):
        for kind in ("snapshot", "backfill", "rehearsal_seed"):
            binary = args.bin_dir / f"windmill_{product}_{kind}"
            if not binary.is_file() or not os.access(binary, os.X_OK):
                parser.error("missing real binary " + str(binary))
    with tempfile.TemporaryDirectory(prefix="products-cutover-test-") as temporary:
        test = CutoverTest(args, Path(temporary))
        try:
            methods = {"success": test.success, "failures": test.failures, "kills": test.kills,
                       "guards": test.guards, "deploy-guards": test.deploy_guards, "forward-only": test.forward_only,
                       "rollback-kill": test.rollback_start_kill, "recovery-kill": test.recovery_restore_kill,
                       "automatic-restore-kill": test.automatic_restore_kill, "prerequisites": test.prerequisites,
                       "legacy-retirement": test.legacy_retirement}
            if args.regression_only:
                methods[args.regression_only]()
            else:
                test.workflows()
                for method in (test.legacy_retirement, test.prerequisites, test.guards, test.deploy_guards, test.success, test.failures, test.kills,
                               test.recovery_restore_kill, test.automatic_restore_kill, test.rollback_start_kill, test.forward_only):
                    method()
            print(json.dumps({"passed": True, "cases": test.cases}, sort_keys=True))
        finally:
            test.cleanup()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--docker-shim"]:
        sys.exit(docker_shim(sys.argv[2:]))
    if sys.argv[1:2] == ["--tool-shim"]:
        sys.exit(tool_shim(sys.argv[2], sys.argv[3:]))
    if sys.argv[1:2] == ["--rehearse-shim"]:
        rehearse_shim(sys.argv[2:])
        sys.exit(0)
    main()
