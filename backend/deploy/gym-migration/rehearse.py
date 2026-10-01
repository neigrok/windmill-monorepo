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


def main():
    parser = argparse.ArgumentParser(description="Appendix C.8 gym migration rehearsal on an offline database")
    parser.add_argument("--bin-dir", type=Path, required=True, help="directory holding the three migration binaries")
    parser.add_argument("--output", type=Path, required=True, help="new directory for evidence")
    parser.add_argument("--now-ms", type=int, help="one clock instant shared by both read snapshots")
    parser.add_argument("--apply-adoption", action="store_true", help="apply db/gym_sync.sql after the first read snapshot")
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
    binaries = {name: args.bin_dir / name for name in ("windmill_gym_snapshot", "windmill_gym_backfill")}
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
    before = snapshot(environment, binaries["windmill_gym_snapshot"], args.output / "reads-before", now,
                      args.output / "snapshot-before.jsonl")
    offline(environment)
    database_dump(environment, args.output / "data-after-snapshot")
    equal_files(args.output / "data-before-snapshot", args.output / "data-after-snapshot", "first read snapshot wrote data")
    routes = route_inventory(backend / "products/gym/routes.cpp")
    if before["restGetRoutes"] != routes:
        raise RuntimeError("REST snapshot inventory differs from gym/routes.cpp: "
                           f"snapshot={before['restGetRoutes']}, routes={routes}")
    if args.apply_adoption:
        run(["psql", "--dbname", database, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", str(backend / "db/gym_sync.sql")],
            environment, args.output / "schema-adoption.log")
    database_dump(environment, args.output / "data-before-dry-run")
    run([str(binaries["windmill_gym_backfill"]), "--dry-run"], environment,
        args.output / "dry-run.jsonl")
    offline(environment)
    database_dump(environment, args.output / "data-after-dry-run")
    equal_files(args.output / "data-before-dry-run", args.output / "data-after-dry-run", "dry-run wrote data")
    run([str(binaries["windmill_gym_backfill"])], environment, args.output / "migration.jsonl")
    offline(environment)
    migrated = database_dump(environment, args.output / "data-migrated")
    after = snapshot(environment, binaries["windmill_gym_snapshot"], args.output / "reads-after", now,
                     args.output / "snapshot-after.jsonl")
    offline(environment)
    database_dump(environment, args.output / "data-after-read")
    equal_files(args.output / "data-migrated", args.output / "data-after-read", "second read snapshot wrote data")
    read_files = equal_files(args.output / "reads-before", args.output / "reads-after", "read response diff")
    run([str(binaries["windmill_gym_backfill"]), "--audit"], environment, args.output / "audit.jsonl")
    run([str(binaries["windmill_gym_backfill"])], environment, args.output / "second-run.jsonl")
    offline(environment)
    second = [json.loads(line) for line in (args.output / "second-run.jsonl").read_text().splitlines()]
    if any(row["changed"] != 0 for row in second):
        raise RuntimeError("second run reported changes")
    database_dump(environment, args.output / "data-after-second-run")
    data_files = equal_files(args.output / "data-migrated", args.output / "data-after-second-run", "second run changed table rows or sequences")
    audit = [json.loads(line) for line in (args.output / "audit.jsonl").read_text().splitlines()]
    report = {"passed": True, "accounts": before["accounts"], "responses": before["responses"],
              "restGetRoutes": len(routes), "mcpReadTools": len(before["mcpReadTools"]),
              "readFilesCompared": read_files, "auditedScopes": len(audit),
              "secondRunChanges": sum(row["changed"] for row in second),
              "tableRowsAndSequencesFilesCompared": data_files,
              "tables": len([row for row in migrated if "table" in row]),
              "initialTableRows": sum(row.get("rows", 0) for row in baseline),
              "nowMs": now}
    (args.output / "result.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"gym rehearsal: {error}", file=sys.stderr)
        sys.exit(1)
