#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid


def run(command, environment, output=None, sql=None):
    result = subprocess.run(command, env=environment, input=sql, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if output:
        output.write_bytes(result.stdout)
        if result.stderr:
            output.with_suffix(output.suffix + ".stderr").write_bytes(result.stderr)
    if result.returncode:
        sys.stderr.buffer.write(result.stderr)
        raise RuntimeError(f"{Path(command[0]).name} failed with status {result.returncode}")
    return result.stdout


def psql(environment, sql):
    return run(["psql", "--dbname", environment["DATABASE_URL"], "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
               environment, sql=sql.encode())


def offline(environment):
    count = int(psql(environment, "SELECT count(*) FROM pg_stat_activity WHERE "
                     "datname=current_database() AND backend_type='client backend' "
                     "AND pid<>pg_backend_pid();").strip())
    if count:
        raise RuntimeError(f"write freeze requires an offline database; {count} other client connections exist")


def quote_identifier(value):
    return '"' + value.replace('"', '""') + '"'


def database_dump(environment, directory):
    directory.mkdir()
    rows = psql(environment,
                "SELECT json_build_array(schemaname,tablename)::text FROM pg_tables "
                "WHERE schemaname NOT IN ('pg_catalog','information_schema') "
                "AND schemaname NOT LIKE 'pg_toast%' ORDER BY schemaname,tablename;")
    manifest = []
    for line in rows.splitlines():
        schema, table = json.loads(line)
        relation = quote_identifier(schema) + "." + quote_identifier(table)
        name = hashlib.sha256(relation.encode()).hexdigest() + ".jsonl"
        data = psql(environment,
                    f"SET timezone='UTC'; SELECT jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)::text FROM {relation} t "
                    "ORDER BY to_jsonb(t)::text COLLATE \"C\";")
        (directory / name).write_bytes(data)
        manifest.append({"table": relation, "file": name, "rows": len(data.splitlines())})
    sequences = psql(environment,
                     "SELECT json_build_array(sequence_schema,sequence_name)::text FROM information_schema.sequences "
                     "WHERE sequence_schema NOT IN ('pg_catalog','information_schema') "
                     "ORDER BY sequence_schema,sequence_name;")
    for line in sequences.splitlines():
        schema, sequence = json.loads(line)
        relation = quote_identifier(schema) + "." + quote_identifier(sequence)
        name = "sequence-" + hashlib.sha256(relation.encode()).hexdigest() + ".jsonl"
        (directory / name).write_bytes(psql(environment, f"SELECT last_value,is_called FROM {relation};"))
        manifest.append({"sequence": relation, "file": name})
    (directory / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    return manifest


def equal_files(before, after, purpose):
    left = {path.relative_to(before): path for path in before.rglob("*") if path.is_file()}
    right = {path.relative_to(after): path for path in after.rglob("*") if path.is_file()}
    differences = sorted(str(name) for name in left.keys() | right.keys()
                         if name not in left or name not in right or left[name].read_bytes() != right[name].read_bytes())
    if differences:
        raise RuntimeError(f"{purpose}: {len(differences)} changed files; first: {', '.join(differences[:5])}")
    return len(left)


def snapshot(environment, binary, output, now, log):
    run([str(binary), "--output", str(output), "--now-ms", str(now)], environment, log)
    return json.loads((output / "inventory.json").read_text())


def route_inventory(source):
    text = source.read_text()
    return sorted(set(re.findall(r'app\.registerHandler\(\s*"([^"]+)"(?:(?!app\.registerHandler).)*?\{drogon::Get\}\)',
                                 text, re.DOTALL)))


def interrupted_account(environment, binary, owner, output):
    owner = str(uuid.UUID(owner))
    name = "wm_journal_rehearsal_pause_" + uuid.uuid4().hex
    identifier = quote_identifier(name)
    process = None
    installed = False
    database_dump(environment, output / "data-before-account-interruption")
    try:
        psql(environment, f"CREATE FUNCTION {identifier}() RETURNS trigger LANGUAGE plpgsql AS $$ "
                         "BEGIN PERFORM pg_sleep(30); RETURN NULL; END $$; "
                         f"CREATE TRIGGER {identifier} BEFORE UPDATE ON journal_page "
                         f"FOR EACH STATEMENT EXECUTE FUNCTION {identifier}();")
        installed = True
        with (output / "journal-interrupted-account.log").open("wb") as log:
            process = subprocess.Popen([str(binary), "--account", owner],
                                       env={**environment, "PGAPPNAME": name}, stdout=log, stderr=log)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("journal interruption fixture exited before its account transaction paused")
                paused = psql(environment, f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' "
                                           "AND state='active' AND wait_event='PgSleep';").strip()
                if paused != b"0":
                    process.terminate()
                    process.wait(timeout=15)
                    process = None
                    break
                time.sleep(0.05)
            else:
                raise RuntimeError("journal account transaction did not reach the before-commit interruption gate")
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if installed:
            psql(environment, f"DROP TRIGGER {identifier} ON journal_page; DROP FUNCTION {identifier}();")
    offline(environment)
    database_dump(environment, output / "data-after-account-interruption")
    equal_files(output / "data-before-account-interruption", output / "data-after-account-interruption",
                "interruption before account commit changed table rows or sequences")


def main():
    parser = argparse.ArgumentParser(description="Appendices C.8 and D.8 gym + journal migration rehearsal on one offline database")
    parser.add_argument("--bin-dir", type=Path, required=True, help="directory holding both products' migration binaries")
    parser.add_argument("--output", type=Path, required=True, help="new directory for evidence")
    parser.add_argument("--now-ms", type=int, help="one clock instant shared by both read snapshots")
    parser.add_argument("--apply-adoption", action="store_true", help="apply both adoption schemas after the first read snapshots")
    args = parser.parse_args()
    environment = dict(os.environ)
    database = environment.get("DATABASE_URL", "")
    if not database:
        parser.error("DATABASE_URL is required")
    environment["PGOPTIONS"] = (environment.get("PGOPTIONS", "") + " -c timezone=UTC").strip()
    args.bin_dir = args.bin_dir.resolve()
    args.output = args.output.resolve()
    if args.output.exists():
        parser.error("--output must name a directory that does not exist")
    products = ("gym", "journal")
    binaries = {name: args.bin_dir / name for product in products
                for name in (f"windmill_{product}_snapshot", f"windmill_{product}_backfill")}
    for binary in binaries.values():
        if not binary.is_file() or not os.access(binary, os.X_OK):
            parser.error(f"missing executable: {binary}")
    backend = Path(__file__).resolve().parents[2]
    now = args.now_ms if args.now_ms is not None else int(time.time() * 1000)
    if now <= 0:
        parser.error("--now-ms must be positive")
    args.output.mkdir(parents=True)
    offline(environment)
    baseline = database_dump(environment, args.output / "data-before-snapshot")
    before = {}
    for product in products:
        before[product] = snapshot(environment, binaries[f"windmill_{product}_snapshot"],
                                   args.output / "reads-before" / product, now,
                                   args.output / f"{product}-snapshot-before.jsonl")
    offline(environment)
    database_dump(environment, args.output / "data-after-snapshot")
    equal_files(args.output / "data-before-snapshot", args.output / "data-after-snapshot", "first read snapshots wrote data")
    routes = {}
    for product in products:
        routes[product] = route_inventory(backend / f"products/{product}/routes.cpp")
        if before[product]["restGetRoutes"] != routes[product]:
            raise RuntimeError(f"REST snapshot inventory differs from {product}/routes.cpp: "
                               f"snapshot={before[product]['restGetRoutes']}, routes={routes[product]}")
    if args.apply_adoption:
        for product in products:
            run(["psql", "--dbname", database, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", str(backend / f"db/{product}_sync.sql")],
                environment, args.output / f"{product}-schema-adoption.log")
    database_dump(environment, args.output / "data-before-dry-run")
    for product in products:
        run([str(binaries[f"windmill_{product}_backfill"]), "--dry-run"], environment,
            args.output / f"{product}-dry-run.jsonl")
    offline(environment)
    database_dump(environment, args.output / "data-after-dry-run")
    equal_files(args.output / "data-before-dry-run", args.output / "data-after-dry-run", "dry-runs wrote data")
    run([str(binaries["windmill_gym_backfill"])], environment, args.output / "gym-migration.jsonl")
    journal_candidates = [json.loads(line) for line in (args.output / "journal-dry-run.jsonl").read_text().splitlines()]
    interruption_owner = next((row["account"] for row in journal_candidates if row["changed"] and row["rows"] > 0), None)
    if interruption_owner:
        interrupted_account(environment, binaries["windmill_journal_backfill"], interruption_owner, args.output)
    journal_owners = [row["account"] for row in journal_candidates]
    if journal_owners:
        # A completed account survives an interruption; the remainder resumes in the full run.
        run([str(binaries["windmill_journal_backfill"]), "--account", journal_owners[0]], environment,
            args.output / "journal-account-prefix.jsonl")
        run([str(binaries["windmill_journal_backfill"]), "--audit", "--account", journal_owners[0]], environment,
            args.output / "journal-account-prefix-audit.jsonl")
    run([str(binaries["windmill_journal_backfill"])], environment, args.output / "journal-migration.jsonl")
    offline(environment)
    migrated = database_dump(environment, args.output / "data-migrated")
    after = {}
    for product in products:
        after[product] = snapshot(environment, binaries[f"windmill_{product}_snapshot"],
                                  args.output / "reads-after" / product, now,
                                  args.output / f"{product}-snapshot-after.jsonl")
    offline(environment)
    database_dump(environment, args.output / "data-after-read")
    equal_files(args.output / "data-migrated", args.output / "data-after-read", "second read snapshots wrote data")
    read_files = equal_files(args.output / "reads-before", args.output / "reads-after", "read response diff")
    audit = {}
    negative_audit = {}
    for product in products:
        run([str(binaries[f"windmill_{product}_backfill"]), "--audit"], environment, args.output / f"{product}-audit.jsonl")
        run([str(binaries[f"windmill_{product}_backfill"]), "--audit", "--test-corruptions"], environment,
            args.output / f"{product}-corruption-audit.jsonl")
        audit[product] = [json.loads(line) for line in (args.output / f"{product}-audit.jsonl").read_text().splitlines()]
        negative_audit[product] = [json.loads(line) for line in (args.output / f"{product}-corruption-audit.jsonl").read_text().splitlines()]
        if any(not row["envelopeAudit"] or row["corruptionsRejected"] == 0 for row in negative_audit[product]):
            raise RuntimeError(f"a migrated {product} scope did not reject recomputed-digest corruptions")
        if product == "journal" and any(not row["bootAudit"] for row in audit[product]):
            raise RuntimeError("a migrated journal scope did not complete null-cursor boot")
    offline(environment)
    database_dump(environment, args.output / "data-after-corruption-audit")
    equal_files(args.output / "data-migrated", args.output / "data-after-corruption-audit", "corruption audits changed table rows or sequences")
    second = {}
    for product in products:
        run([str(binaries[f"windmill_{product}_backfill"])], environment, args.output / f"{product}-second-run.jsonl")
        second[product] = [json.loads(line) for line in (args.output / f"{product}-second-run.jsonl").read_text().splitlines()]
        if any(row["changed"] != 0 for row in second[product]):
            raise RuntimeError(f"second {product} run reported changes")
    offline(environment)
    database_dump(environment, args.output / "data-after-second-run")
    data_files = equal_files(args.output / "data-migrated", args.output / "data-after-second-run", "second runs changed table rows or sequences")
    adopted_pages = psql(environment, "SELECT jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)::text FROM journal_page t ORDER BY user_id,day;")
    run(["psql", "--dbname", database, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", str(backend / "db/schema.sql")],
        environment, args.output / "bootstrap-rerun.log")
    if adopted_pages != psql(environment, "SELECT jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)::text FROM journal_page t ORDER BY user_id,day;"):
        raise RuntimeError("schema bootstrap rerun changed adopted journal pages")
    run([str(binaries["windmill_journal_backfill"]), "--audit"], environment, args.output / "journal-bootstrap-audit.jsonl")
    per_product = {product: {"accounts": before[product]["accounts"], "responses": before[product]["responses"],
                            "restGetRoutes": len(routes[product]), "mcpReadTools": len(before[product].get("mcpReadTools", [])),
                            "auditedScopes": len(audit[product]),
                            "corruptionsRejected": sum(row["corruptionsRejected"] for row in negative_audit[product]),
                            "secondRunChanges": sum(row["changed"] for row in second[product])}
                   for product in products}
    report = {"passed": True, "accounts": before["gym"]["accounts"],
              "responses": sum(before[product]["responses"] for product in products),
              "restGetRoutes": sum(len(routes[product]) for product in products),
              "mcpReadTools": len(before["gym"]["mcpReadTools"]),
              "readFilesCompared": read_files, "auditedScopes": sum(len(audit[product]) for product in products),
              "corruptionsRejected": sum(sum(row["corruptionsRejected"] for row in negative_audit[product]) for product in products),
              "secondRunChanges": sum(sum(row["changed"] for row in second[product]) for product in products),
              "tableRowsAndSequencesFilesCompared": data_files,
              "tables": len([row for row in migrated if "table" in row]),
              "initialTableRows": sum(row.get("rows", 0) for row in baseline),
              "journalBootstrapUnchanged": True, "journalAccountResume": bool(journal_owners),
              "journalBeforeCommitInterruption": bool(interruption_owner),
              "products": per_product, "nowMs": now}
    (args.output / "result.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"gym + journal rehearsal: {error}", file=sys.stderr)
        sys.exit(1)
