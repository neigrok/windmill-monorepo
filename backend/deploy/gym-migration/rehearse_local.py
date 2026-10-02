#!/usr/bin/env python3
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

sys.dont_write_bytecode = True
from rehearse import run, psql


def main():
    parser = argparse.ArgumentParser(description="Seed and remove two disposable databases for the local migration gates")
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--maintenance-db", default="postgresql:///postgres?host=/tmp")
    args = parser.parse_args()
    args.bin_dir = args.bin_dir.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    backend = Path(__file__).resolve().parents[2]
    reports = []
    for case in ("plain", "early-engine"):
        database = "wm_products_rehearsal_" + str(time.time_ns())
        environment = {**os.environ, "DATABASE_URL": args.maintenance_db, "GYM_ENGINE_WRITES": "0", "GYM_WRITE_FREEZE": "0",
                       "JOURNAL_ENGINE_WRITES": "0", "JOURNAL_WRITE_FREEZE": "0"}
        output = args.output / case
        output.mkdir()
        created = False
        process = None
        connection = None
        try:
            run(["createdb", "--maintenance-db=" + args.maintenance_db, database], environment)
            created = True
            # libpq accepts an explicit dbname overriding the maintenance URL's database.
            environment["DATABASE_URL"] = "dbname=" + args.maintenance_db + " dbname=" + database
            run(["psql", environment["DATABASE_URL"], "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(backend / "db/schema.sql")],
                environment, output / "schema.log")
            seed = run([str(args.bin_dir / "windmill_gym_rehearsal_seed")], environment, output / "seed.jsonl")
            run([str(args.bin_dir / "windmill_journal_rehearsal_seed")], environment, output / "journal-seed.jsonl")
            early = None
            if case == "early-engine":
                run(["psql", environment["DATABASE_URL"], "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(backend / "db/gym_sync.sql")],
                    environment, output / "adoption-schema.log")
                run(["psql", environment["DATABASE_URL"], "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(backend / "db/journal_sync.sql")],
                    environment, output / "journal-adoption-schema.log")
                owner = next(row["account"] for row in map(json.loads, seed.splitlines()) if row["fixture"] == 1)
                token = hashlib.sha256(b"gym-local-rehearsal").hexdigest()
                psql(environment, f"INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('{token}','{owner}',99999999999999)")
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", 0))
                    port = probe.getsockname()[1]
                server_env = {**environment, "GYM_ENGINE_WRITES": "1", "JOURNAL_ENGINE_WRITES": "1", "PORT": str(port), "WINDMILL_HOST": "127.0.0.1",
                              "ANTHROPIC_API_KEY": "", "RESEND_API_KEY": "", "SENTRY_DSN": "", "AMPLITUDE_API_KEY": ""}
                with (output / "early-server.log").open("wb") as log:
                    process = subprocess.Popen([str(args.bin_dir / "windmill_server")], cwd=output,
                                               env=server_env, stdout=log, stderr=log)
                for attempt in range(100):
                    try:
                        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                        connection.request("GET", "/v1/gym/sessions", headers={"Cookie": "wm_session=gym-local-rehearsal"})
                        response = connection.getresponse()
                        body = response.read()
                        break
                    except (OSError, http.client.HTTPException):
                        if connection: connection.close()
                        time.sleep(0.1)
                else:
                    raise RuntimeError("early engine server did not start")
                early = {"status": response.status, "body": json.loads(body)}
                assert early["status"] == 503 and early["body"]["code"] == "gym-not-adopted", early
                connection.request("PUT", "/v1/journal/page/2026-09-01",
                                   body=json.dumps({"body": "Refuse unadopted history", "stamp": "1790856000001:0:rehearsal"}),
                                   headers={"Cookie": "wm_session=gym-local-rehearsal", "Content-Type": "application/json"})
                journal_response = connection.getresponse()
                journal_early = {"status": journal_response.status, "body": json.loads(journal_response.read())}
                assert journal_early["status"] == 503 and journal_early["body"]["code"] == "journal-not-adopted", journal_early
                early["journal"] = journal_early
                assert psql(environment, "SELECT count(*) FROM sync_scopes").strip() == b"0"
                connection.close()
                connection = None
                process.terminate()
                process.wait(timeout=15)
                process = None
                # Reproduce the empty scope left by an older writer, then require full adoption.
                psql(environment, f"INSERT INTO sync_scopes(key,kind,owner) VALUES ('acct:{owner}/gym','product','{owner}')")
                (output / "early-engine.json").write_text(json.dumps(early, indent=2) + "\n")
            command = ["python3", str(Path(__file__).with_name("rehearse.py")), "--bin-dir", str(args.bin_dir),
                       "--output", str(output / "evidence")]
            if case == "plain": command.append("--apply-adoption")
            run(command, environment, output / "rehearsal.log")
            result = json.loads((output / "evidence/result.json").read_text())
            reports.append({"case": case, **result, "earlyEngine": early})
        finally:
            if connection: connection.close()
            if process:
                process.terminate()
                try: process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if created:
                run(["dropdb", "--force", "--maintenance-db=" + args.maintenance_db, database], dict(os.environ))
    (args.output / "result.json").write_text(json.dumps(reports, indent=2) + "\n")
    print(json.dumps(reports, sort_keys=True))


if __name__ == "__main__":
    main()
