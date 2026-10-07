from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit, urlunsplit


BACKEND = Path(__file__).resolve().parents[2]


def command(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError(Path(args[0]).name + ": " + result.stderr.decode())
    return result.stdout


def database_url(maintenance, name):
    parts = urlsplit(maintenance)
    if not parts.netloc:
        return parts.scheme + ":///" + name + ("?" + parts.query if parts.query else "")
    return urlunsplit(parts._replace(path="/" + name))


class Differential:
    def __init__(self, args, directory):
        self.args, self.directory = args, directory
        self.processes, self.databases, self.connections = [], [], []
        self.main_binary = None
        self.clock_file = directory / "clock-ms"
        self.clock_ms = int(time.time() * 1000) + 60000
        self.clock_file.write_text(str(self.clock_ms))

    def sql(self, database, sql):
        return command(["psql", database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql]).decode().strip()

    # Each server runs on the schema its own tree deploys: the baseline's database is built from origin/main's.
    def schemas(self):
        baseline = self.directory / "origin-main-schema.sql"
        baseline.write_bytes(command(["git", "-c", "safe.directory=" + str(BACKEND.parent), "-C", str(BACKEND.parent),
                                      "show", "origin/main:backend/db/schema.sql"]))
        return [baseline, BACKEND / "db/schema.sql"]

    def build_main(self):
        repository = self.directory / "baseline.git"
        command(["git", "-c", "safe.directory=" + str(BACKEND.parent), "clone", "--mirror", "--shared",
                 str(BACKEND.parent), str(repository)])
        worktree = self.directory / "origin-main"
        command(["git", "-C", str(repository), "worktree", "add", "--detach", str(worktree), "origin/main"])
        baseline = worktree / "backend"
        # Identical, test-only clock instrumentation; no application sources are patched.
        clock = Path("platform/adapters/clock/SystemClock.h")
        (baseline / clock).write_bytes((BACKEND / clock).read_bytes())
        with (baseline / "CMakeLists.txt").open("a") as output:
            output.write("\ntarget_compile_definitions(windmill_server PRIVATE WM_TEST_CLOCK=1)\n")
        (self.directory / "origin-main-sha.txt").write_bytes(command(["git", "-C", str(worktree), "rev-parse", "HEAD"]))
        (self.directory / "origin-main-clock.patch").write_bytes(command(["git", "-C", str(worktree), "diff"]))
        build = self.directory / "origin-main-build"
        configure = ["cmake", "-S", str(baseline), "-B", str(build)]
        if self.args.drogon_prefix:
            configure.append("-DWM_DROGON_PREFIX=" + str(self.args.drogon_prefix))
        with (self.directory / "origin-main-build.log").open("wb") as log:
            for invocation in (configure, ["cmake", "--build", str(build), "-j" + str(self.args.jobs),
                                           "--target", "windmill_server"]):
                result = subprocess.run(invocation, stdout=log, stderr=subprocess.STDOUT)
                if result.returncode:
                    raise RuntimeError("origin/main build failed: " + str(self.directory / "origin-main-build.log"))
        self.main_binary = build / "windmill_server"
