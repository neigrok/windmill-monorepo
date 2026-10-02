#!/usr/bin/env python3
import argparse
import base64
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
from gym_write_differential import BACKEND, Differential, command, database_url


ACCOUNT = "30000000-0000-4000-8000-000000000001"
OTHER = "30000000-0000-4000-8000-000000000002"
BLANK = "30000000-0000-4000-8000-000000000003"
REVISIONS = "30000000-0000-4000-8000-000000000004"
UNADOPTED = "30000000-0000-4000-8000-000000000005"
PAGINATION = "30000000-0000-4000-8000-000000000006"
REVERSE_TIES = "30000000-0000-4000-8000-000000000007"
UPDATED_TIES = "30000000-0000-4000-8000-000000000008"
ADMIN = "journal-differential-admin"
WEBHOOK_KEY = b"journal-differential-webhook-key"
FROZEN = {"code": "journal-frozen", "error": "journal writes are temporarily frozen"}
NOT_ADOPTED = {"code": "journal-not-adopted",
               "error": "journal history must be adopted before engine writes are enabled"}


class JournalDifferential(Differential):
    def __init__(self, args, directory):
        super().__init__(args, directory)
        self.servers = []
        self.launches = 0
        self.armed = self.frozen = False
        self.covered = set()
        self.freeze_covered = set()
        self.equal_hlc_cohorts = {}
        source = (BACKEND / "products/journal/routes.cpp").read_text()
        self.inventory = [(verb.upper(), route) for route, verb in re.findall(
            r'app\.registerHandler\(\s*"([^"]+)"[\s\S]*?\{drogon::(Get|Post|Put|Patch|Delete)\}\);', source)]
        self.declared = set(self.inventory)
        assert self.declared, "journal route inventory is empty"

    def environment(self, side, database, port):
        engine = side if self.args.mode == "off-vs-on" else 0
        return {"DATABASE_URL": database, "PORT": str(port), "GYM_ENGINE_WRITES": "0",
                "GYM_WRITE_FREEZE": "0", "JOURNAL_ENGINE_WRITES": str(engine),
                "JOURNAL_WRITE_FREEZE": str(int(self.frozen)),
                "JOURNAL_NUDGE_ENABLED": str(int(self.armed)),
                "JOURNAL_NUDGE_ALLOWLIST": ACCOUNT if self.armed else "",
                "JOURNAL_NUDGE_ADMIN_TOKEN": ADMIN, "JOURNAL_ECHO_ADMIN_TOKEN": ADMIN,
                "JOURNAL_EMBEDDER_URL": "", "ANTHROPIC_API_KEY": "", "OPENAI_API_KEY": "",
                "RESEND_API_KEY": "", "SENTRY_DSN": "", "AMPLITUDE_API_KEY": "",
                "RESEND_WEBHOOK_SECRET": "whsec_" + base64.b64encode(WEBHOOK_KEY).decode(),
                "REMINDERS_ENABLED": "0", "REMINDERS_ALLOWLIST": "",
                "WINDMILL_OWNER_EMAILS": "journal-diff@example.com",
                "WM_TEST_CLOCK_FILE": str(self.clock_file),
                "PGOPTIONS": "-c search_path=public,pg_catalog -c timezone=UTC",
                "WINDMILL_HOST": "127.0.0.1", "WINDMILL_APP_URL": "http://journal.test",
                "WINDMILL_API_URL": "http://journal.test", "WINDMILL_COOKIE_DOMAIN": "",
                "WINDMILL_MCP_TOKEN": ""}

    def sql(self, database, sql):
        return command(["psql", database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql],
            env={**os.environ, "PGOPTIONS": "-c search_path=public,pg_catalog -c timezone=UTC"}).decode().strip()

    def start(self, side, database, port):
        environment = self.environment(side, database, port)
        self.launches += 1
        log = self.directory / f"server-{self.launches}-{side}.log"
        if self.args.image:
            name = f"journal-diff-{os.getpid()}-{self.launches}-{side}"
            self.containers.append(name)
            fields = [item for key, value in environment.items() for item in ("-e", key + "=" + value)]
            command(["docker", "run", "-d", "--name", name, "--network", "host",
                     "-v", str(self.directory) + ":" + str(self.directory) + ":ro", *fields,
                     self.args.image, str(self.args.bin_dir / "windmill_server_test_clock")])
            self.servers.append(name)
        else:
            inherited = {key: value for key, value in os.environ.items()
                         if not key.startswith(("JOURNAL_", "GYM_"))}
            binary = self.main_binary if side == 0 and self.main_binary else self.args.bin_dir / "windmill_server_test_clock"
            with log.open("wb") as output:
                process = subprocess.Popen([str(binary)],
                    cwd=self.directory, env={**inherited, **environment}, stdout=output, stderr=output)
            self.processes.append(process)
            self.servers.append(process)
        for attempt in range(100):
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
                connection.request("GET", "/v1/journal/pages")
                response = connection.getresponse()
                response.read()
                assert response.status == 401
                self.connections.append(connection)
                return
            except (OSError, http.client.HTTPException):
                time.sleep(0.1)
        raise AssertionError("server did not start: " + str(log))

    def restart(self):
        for connection in self.connections:
            connection.close()
        self.connections.clear()
        for server in self.servers:
            if isinstance(server, str):
                command(["docker", "stop", "-t", "15", server])
            else:
                server.terminate()
                try:
                    server.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
        self.servers.clear()
        for side, (_, database) in enumerate(self.databases):
            self.start(side, database, self.ports[side])

    def snapshot(self, database):
        tables = self.sql(database, "SELECT tablename FROM pg_tables WHERE schemaname='public' "
            "AND (tablename LIKE 'journal_%' OR tablename LIKE 'sync_%') ORDER BY tablename").splitlines()
        return {table: self.sql(database, "SELECT coalesce(jsonb_agg(row ORDER BY row::text)::text,'[]') FROM "
            f"(SELECT to_jsonb(t) || jsonb_build_object('rowXmin',xmin::text,'rowCtid',ctid::text) AS row FROM {table} t) rows")
            for table in tables}

    def setup(self):
        if self.args.mode == "main-vs-off":
            self.build_main()
        self.ports = []
        for port in range(18950, 19000):
            with socket.socket() as probe:
                try:
                    probe.bind(("127.0.0.1", port))
                    self.ports.append(port)
                except OSError:
                    continue
            if len(self.ports) == 2:
                break
        assert len(self.ports) == 2, "need two free loopback ports in 18950–18999"
        stamp = str(time.time_ns())
        pause_hash = hashlib.sha256(b"journal-differential-pause").hexdigest()
        seed = f"""
          INSERT INTO users(id,email,name) VALUES ('{ACCOUNT}','journal-diff@example.com','Journal'),
            ('{OTHER}','journal-other@example.com','Other'),
            ('{BLANK}','journal-blank@example.com','Blank'),
            ('{REVISIONS}','journal-revisions@example.com','Revisions'),
            ('{PAGINATION}','journal-pagination@example.com','Pagination');
          INSERT INTO journal_page(user_id,day,body,mood,energy,source,stamp_ms,stamp_counter,stamp_actor,updated_at) VALUES
            ('{ACCOUNT}','2026-01-01','Past passage',0,NULL,'spoken',100,2,'seed','2026-01-01 00:00:00.123456+00'),
            ('{ACCOUNT}','2026-01-02','A second passage',NULL,10,'typed',100,2,'seed','2026-01-02 00:00:00.987654+00'),
            ('{ACCOUNT}','2026-01-03','',NULL,NULL,'typed',0,0,'','2026-01-03'),
            ('{ACCOUNT}','2026-01-04','Future stamp',NULL,NULL,'typed',4102444800000,0,'future','2026-01-04'),
            ('{ACCOUNT}','2026-01-05',E' \\t\\n',NULL,NULL,'typed',101,0,'seed','2026-01-05'),
            ('{BLANK}','2026-01-01','',NULL,NULL,'typed',0,0,'','2026-01-01');
          INSERT INTO journal_page(user_id,day,body,stamp_ms,stamp_actor,updated_at)
            SELECT '{PAGINATION}', date '2000-01-01' + n - 1, 'Page ' || n, 1000+n,
              'pagination', timestamptz '2000-01-01 00:00:00+00' + n * interval '1 day'
            FROM generate_series(1,1002) n;
          INSERT INTO journal_page_revision(user_id,day,body,stamp_ms,stamp_counter,stamp_actor,superseded_at) VALUES
            ('{ACCOUNT}','2026-01-01','Expired retained history',1,0,'old','2025-01-01'),
            ('{ACCOUNT}','2026-01-01','Repeated retained history',2,0,'old',now()),
            ('{ACCOUNT}','2026-01-02','Repeated retained history',3,0,'old',now()),
            ('{REVISIONS}','2026-01-01','Revision without a page',0,0,'','2026-01-01');
          INSERT INTO journal_nudge(user_id,enabled,channel,next_due_at,slot_day,suppressed,pause_digest) VALUES
            ('{ACCOUNT}',false,'email',to_timestamp({self.clock_ms}/1000.0)+interval '365 days','2027-01-01',true,'{pause_hash}');
          INSERT INTO journal_span(user_id,span_id,day,ord,lo,hi,text,text_sha256,vector,embed_version,body_stamp_ms,body_sha256) VALUES
            ('{ACCOUNT}',1,'2026-01-01',0,0,12,'Past passage',sha256(convert_to('Past passage','UTF8')),decode('0000803f','hex'),'test',100,sha256(convert_to('Past passage','UTF8'))),
            ('{ACCOUNT}',2,'2026-01-02',0,0,16,'A second passage',sha256(convert_to('A second passage','UTF8')),decode('0000803f','hex'),'test',100,sha256(convert_to('A second passage','UTF8'))),
            ('{ACCOUNT}',3,'2026-01-04',0,0,12,'Future stamp',sha256(convert_to('Future stamp','UTF8')),decode('0000803f','hex'),'test',4102444800000,sha256(convert_to('Future stamp','UTF8')));
          INSERT INTO journal_echo(user_id,trigger_day,trigger_span_id,match_day,match_span_id,cosine,relation,curator_version) VALUES
            ('{ACCOUNT}','2026-01-02',2,'2026-01-01',1,0.75,0.8,'test'),
            ('{ACCOUNT}','2026-01-04',3,'2026-01-01',1,0.85,0.9,'test');
        """
        accounts = [ACCOUNT, OTHER, BLANK, REVISIONS, PAGINATION]
        if self.args.mode == "main-vs-off":
            accounts += [REVERSE_TIES, UPDATED_TIES]
            seed += f"""
              INSERT INTO users(id,email,name) VALUES
                ('{REVERSE_TIES}','journal-reverse-ties@example.com','Reverse ties'),
                ('{UPDATED_TIES}','journal-updated-ties@example.com','Updated ties');
              INSERT INTO journal_page(user_id,day,body,stamp_ms,stamp_counter,stamp_actor,updated_at) VALUES
                ('{REVERSE_TIES}','2026-09-03','Reverse third',600,7,'cohort','2026-09-03'),
                ('{REVERSE_TIES}','2026-09-02','Reverse second',600,7,'cohort','2026-09-02'),
                ('{REVERSE_TIES}','2026-09-01','Reverse first',600,7,'cohort','2026-09-01'),
                ('{UPDATED_TIES}','2026-10-01','Original first',600,7,'cohort','2026-10-01'),
                ('{UPDATED_TIES}','2026-10-02','Original second',600,7,'cohort','2026-10-02'),
                ('{UPDATED_TIES}','2026-10-03','Original third',600,7,'cohort','2026-10-03');
            """
        for side in range(2):
            name = f"wm_journal_diff_{stamp}_{side}"
            command(["createdb", "--maintenance-db=" + self.args.maintenance_db, name])
            database = database_url(self.args.maintenance_db, name)
            self.databases.append((name, database))
            self.sql(database, f"CREATE TABLE differential_clock(ms bigint NOT NULL); INSERT INTO differential_clock VALUES ({self.clock_ms}); "
                "CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS "
                "'SELECT to_timestamp(ms / 1000.0) FROM public.differential_clock';")
            command(["psql", database, "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(BACKEND / "db/schema.sql")],
                env={**os.environ, "PGOPTIONS": "-c search_path=public,pg_catalog -c timezone=UTC"})
            if self.args.mode == "main-vs-off":
                # Equal-HLC peers must see matching planner state in the two disposable stores.
                self.sql(database, "ALTER TABLE journal_page SET (autovacuum_enabled=false)")
            self.sql(database, seed)
            for account in accounts:
                digest = hashlib.sha256(("journal-differential-" + account).encode()).hexdigest()
                self.sql(database, f"INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('{digest}','{account}',99999999999999)")
            if side and self.args.mode == "off-vs-on":
                command(["psql", database, "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(BACKEND / "db/journal_sync.sql")])
                before = self.snapshot(database)
                report = self.binary("windmill_journal_backfill", {"DATABASE_URL": database}, "--dry-run")
                (self.directory / "dry-run.jsonl").write_bytes(report)
                assert before == self.snapshot(database), "dry run mutated the store"
                self.binary("windmill_journal_backfill", {"DATABASE_URL": database}, "--account", ACCOUNT)
                report = self.binary("windmill_journal_backfill", {"DATABASE_URL": database})
                (self.directory / "backfill.jsonl").write_bytes(report)
                audit = self.binary("windmill_journal_backfill", {"DATABASE_URL": database}, "--audit", "--test-corruptions")
                (self.directory / "audit.jsonl").write_bytes(audit)
                rows = [json.loads(line) for line in audit.splitlines()]
                assert rows and all(row["audit"] and row["envelopeAudit"] for row in rows), rows
                assert sum(row.get("corruptionsRejected", 0) for row in rows) > 0, rows
                before = self.snapshot(database)
                report = self.binary("windmill_journal_backfill", {"DATABASE_URL": database})
                assert all(not json.loads(line)["changed"] for line in report.splitlines()), report
                assert before == self.snapshot(database), "second run mutated the store"
            self.start(side, database, self.ports[side])

    def request(self, side, method, target, body, headers=None):
        payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        fields = {"Content-Type": "application/json", "Cookie": "wm_session=journal-differential-" + ACCOUNT,
                  "X-Request-Id": "journal-diff-" + str(self.count)}
        fields.update(headers or {})
        self.connections[side].request(method, target, payload, fields)
        response = self.connections[side].getresponse()
        return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()

    def compare(self, responses, label):
        assert responses[0][0] == responses[1][0], (label, responses)
        if responses[0][2] != responses[1][2]:
            for side, response in enumerate(responses):
                (self.directory / f"failure-{side}.txt").write_bytes(response[2])
            raise AssertionError(label + ": body differs; see " + str(self.directory))
        for status, fields, body in responses:
            if "content-length" in fields and status != 304:
                assert int(fields["content-length"]) == len(body), (label, "invalid Content-Length")
        ignored = {"date", "connection", "keep-alive"}
        fields = [{key: value for key, value in response[1].items() if key not in ignored} for response in responses]
        assert fields[0] == fields[1], (label, "headers", fields)

    def pair(self, method, target, body=None, expected=None, headers=None, error=None):
        self.advance_clock()
        responses = [self.request(side, method, target, body, headers) for side in range(2)]
        self.count += 1
        label = f"{self.count}: {method} {target}"
        self.compare(responses, label)
        if expected is not None:
            assert all(response[0] == expected for response in responses), (label, responses)
        data = json.loads(responses[0][2]) if responses[0][2].startswith((b"{", b"[")) else None
        if error is not None:
            assert data == error, (label, data, error)
        if method == "GET":
            self.reads += 1
        path = target.split("?", 1)[0]
        matches = [(verb, route) for verb, route in self.inventory if verb == method and
            re.fullmatch(re.sub(r"\{[^}]+\}", "[^/]+", route), path)]
        if path.startswith(("/v1/journal/", "/v1/admin/journal/")):
            assert matches, ("route inventory match", method, path)
            self.covered.add(matches[0])
            if self.frozen and method != "GET":
                self.freeze_covered.add(matches[0])
        return data

    def write(self, method, target, body=None, expected=200, headers=None, error=None, readback=True):
        self.writes += 1
        fields = {"X-Request-Id": "journal-write-" + str(self.writes), **(headers or {})}
        data = self.pair(method, target, body, expected, fields, error)
        retry = self.pair(method, target, body, expected, fields, error)
        assert data == retry, ("retry changed its reply", target, data, retry)
        if readback:
            self.readback()
        return data

    def readback(self, account=ACCOUNT):
        headers = {"Cookie": "wm_session=journal-differential-" + account}
        pages = self.pair("GET", "/v1/journal/pages", expected=200, headers=headers)["pages"]
        for page in pages:
            assert self.pair("GET", "/v1/journal/page/" + page["day"], expected=200, headers=headers) == page
        for target in ("/v1/journal/export", "/v1/journal/pages?from=0001-01-01&to=9999-12-31",
                       "/v1/journal/pages?from=9999-12-31&to=0001-01-01",
                       "/v1/journal/pages?from=bad", "/v1/journal/pages?to=bad",
                       "/v1/journal/pages?since=0:0:&limit=1", "/v1/journal/pages?since=100:2:seed&limit=2",
                       "/v1/journal/pages?since=4102444800000:0:future&limit=1001",
                       "/v1/journal/pages?since=0:0:&limit=bad", "/v1/journal/pages?since=0:0:&limit=-1",
                       "/v1/journal/pages?since=0:0:&from=bad&to=bad&limit=0",
                       "/v1/journal/echoes", "/v1/journal/echoes?from=2026-01-01&to=2026-01-04",
                       "/v1/journal/nudge", "/v1/admin/journal/echo/explain/2026-01-02?token=" + ADMIN):
            self.pair("GET", target, expected=200, headers=headers)

    def pagination(self):
        headers = {"Cookie": "wm_session=journal-differential-" + PAGINATION}
        for suffix, count in (("", 500), ("&limit=1", 1), ("&limit=500", 500),
                ("&limit=1000", 1000), ("&limit=1001", 1000), ("&limit=0", 500),
                ("&limit=-1", 500), ("&limit=bad", 500), ("&limit=1x", 500),
                ("&limit=99999999999999999999999", 500), ("&from=bad&to=bad", 500)):
            pages = self.pair("GET", "/v1/journal/pages?since=0:0:" + suffix, expected=200, headers=headers)["pages"]
            assert len(pages) == count and pages[0]["stamp"] == "1001:0:pagination", (suffix, len(pages))
        for cursor, suffix, count in (("1500:0:pagination", "", 500), ("1500:0:pagination", "&limit=1000", 502),
                                     ("2001:0:pagination", "", 1), ("2002:0:pagination", "", 0)):
            pages = self.pair("GET", "/v1/journal/pages?since=" + cursor + suffix, expected=200, headers=headers)["pages"]
            assert len(pages) == count, (cursor, suffix, len(pages))
        for target in ("/v1/journal/pages", "/v1/journal/export",
                       "/v1/journal/pages?from=0001-01-01&to=9999-12-31"):
            assert len(self.pair("GET", target, expected=200, headers=headers)["pages"]) == 1002

    def equal_hlc_sequence(self):
        for name, account, month, stamp in (("reverseInserted", REVERSE_TIES, "09", "600:7:cohort"),
                ("laterUpdated", UPDATED_TIES, "10", "700:9:cohort")):
            headers = {"Cookie": "wm_session=journal-differential-" + account}
            days = [f"2026-{month}-0{day}" for day in range(1, 4)]
            if account == UPDATED_TIES:
                for day in reversed(days):
                    saved = self.write("PUT", "/v1/journal/page/" + day,
                        {"body": "Updated " + day, "stamp": stamp}, headers=headers, readback=False)
                    assert saved["day"] == day and saved["stamp"] == stamp, saved
            observed = {}
            for suffix, count, label in (("", 3, "full"), ("&limit=1", 1, "limit1"), ("&limit=2", 2, "limit2")):
                pages = self.pair("GET", "/v1/journal/pages?since=0:0:" + suffix,
                    expected=200, headers=headers)["pages"]
                assert len(pages) == count and all(page["stamp"] == stamp for page in pages), pages
                order = [page["day"] for page in pages]
                assert len(set(order)) == count and set(order) <= set(days), order
                if label == "full":
                    assert set(order) == set(days), order
                observed[label] = order
            assert observed["limit1"] != [min(days)], (name, "fixture does not expose the day tie-break", observed)
            assert self.pair("GET", "/v1/journal/pages?since=" + stamp,
                expected=200, headers=headers)["pages"] == []
            self.equal_hlc_cohorts[name] = observed

    def page_sequence(self):
        target = "/v1/journal/page/2026-08-01"
        self.write("PUT", target, {})
        self.write("PUT", target, {"body": "Tie must lose", "stamp": "0:0:"})
        for counter, value in enumerate(({}, {"mood": 0, "energy": 10}, {"mood": -1, "energy": 11},
                {"mood": 1.5, "energy": "5"}, {"mood": True, "energy": []},
                {"mood": None, "energy": None}, {"source": "spoken"}, {"source": "other"}), 1):
            written_at = self.clock_ms + 1000
            saved = self.write("PUT", target, {"body": "Writing π 🙂", "stamp": f"200:{counter}:rest", **value,
                "day": "1999-01-01", "updatedAt": 1, "ignored": {"nested": True}})
            assert saved["day"] == "2026-08-01" and saved["updatedAt"] == written_at, saved
        winner = self.write("PUT", target, {"body": "Winner", "stamp": "201:1:z"})
        for stamp in ("200:999:z", "201:0:z", "201:1:a", "201:1:z"):
            assert self.write("PUT", target, {"body": "Must lose", "stamp": stamp}) == winner
        self.write("PUT", target, {"body": "", "mood": 0, "stamp": "201:2:a"})
        self.write("PUT", target, {"stamp": "201:3:a"})
        self.write("PUT", target, {"body": "Same body", "stamp": "202:0:rest"})
        for counter in range(1, 14):
            self.write("PUT", target, {"body": "Same body", "mood": counter % 11,
                "stamp": f"202:{counter}:rest"}, readback=False)
        self.readback()
        for date in ("0001-01-01", "2024-02-29", "9999-12-31"):
            self.write("PUT", "/v1/journal/page/" + date, {"body": date, "stamp": "300:0:calendar"})
        for date in ("0000-01-01", "2026-02-29", "2026-13-01", "2026-01-00", "2026-1-01"):
            self.write("PUT", "/v1/journal/page/" + date, {}, 400, error={"error": "bad date"}, readback=False)
        for value in ([], "text", {"body": []}, {"source": []}, {"stamp": []}, {"stamp": "bad"},
                      {"stamp": "-1:0:rest"}, {"stamp": "1:4294967296:rest"}):
            self.write("PUT", target, value, 400, error={"error": "could not read that page"}, readback=False)
        self.write("PUT", target, b"not json", 400, error={"error": "expected json"}, readback=False)
        self.write("PUT", target, {"body": "é" * 65536, "stamp": "400:0:rest"}, readback=False)
        for stamp in ("0:0:", "401:0:rest"):
            self.write("PUT", target, {"body": "é" * 65537, "stamp": stamp}, 413,
                       error={"error": "that page is too long to store"}, readback=False)
        self.write("PUT", target, {"body": "Final page", "source": "spoken", "stamp": "402:0:rest"})
        self.write("PUT", "/v1/journal/page/2026-01-04", {"body": "Future loses", "stamp": "999:0:rest"})
        for account in (OTHER, BLANK, REVISIONS):
            self.write("PUT", "/v1/journal/page/2026-08-02", {"body": "First accepted page", "stamp": "500:0:first"},
                       headers={"Cookie": "wm_session=journal-differential-" + account}, readback=False)
            self.readback(account)

    def deferred_sequence(self):
        for suffix in ("offer/dismiss", "2026-01-01/useful", "2026-01-01/opened", "2026-01-01/dismiss", "dismiss"):
            self.write("POST", "/v1/journal/echoes/2026-01-02/" + suffix, expected=204)
            self.write("POST", "/v1/journal/echoes/bad/" + suffix, expected=400,
                       error={"error": "bad date"}, readback=False)
        for value, sentence in (([], "send the nudge fields to change"), ({"enabled": 1}, "enabled must be true or false"),
                ({"channel": 1}, "channel must be a string"), ({"nextDueAt": -1}, "nextDueAt must be a millisecond timestamp"),
                ({"slotDay": "2026-02-29"}, "slotDay must be YYYY-MM-DD"), ({"pausedUntil": 0.5}, "pausedUntil must be a millisecond timestamp")):
            self.write("PATCH", "/v1/journal/nudge", value, 400, error={"error": sentence}, readback=False)
        self.write("PATCH", "/v1/journal/nudge", {"enabled": True}, 403,
                   error={"error": "nudges aren't switched on for this account yet"})
        self.write("PATCH", "/v1/journal/nudge", {"enabled": False, "channel": "custom", "nextDueAt": self.clock_ms + 31536000000,
            "slotDay": "2027-01-01", "pausedUntil": 0})
        self.write("PATCH", "/v1/journal/nudge", {})
        for secret in ("", "wrong", "journal-differential-pause"):
            self.write("POST", "/v1/journal/nudge/pause", expected=204, headers={"Authorization": "Bearer " + secret})
            self.write("POST", "/v1/journal/nudge/unsubscribe?t=" + secret, expected=204)
        for family in ("nudge", "echo"):
            target = "/v1/admin/journal/" + family + "/sweep"
            self.write("POST", target, {}, 403, error={"error": "admin token required"}, readback=False)
            self.write("POST", target + "?token=" + ADMIN, {}, headers={"x-admin-token": "wrong"}, expected=403,
                       error={"error": "admin token required"}, readback=False)
            self.write("POST", target + "?token=" + ADMIN, {"asOfMs": self.clock_ms} if family == "nudge" else {"sinceMs": 1})
        self.write("POST", "/v1/admin/journal/nudge/sweep", {"dryRun": "true"}, 400,
                   headers={"x-admin-token": ADMIN}, error={"error": "dryRun must be true or false"}, readback=False)
        self.write("POST", "/v1/admin/journal/nudge/sweep", {"asOfMs": -1}, 400,
                   headers={"x-admin-token": ADMIN}, error={"error": "asOfMs must be a millisecond timestamp"}, readback=False)
        for query in ("-1", "1.5", "18446744073709551616"):
            self.write("POST", "/v1/admin/journal/nudge/sweep?token=" + ADMIN + "&asOfMs=" + query, {}, 400,
                       error={"error": "asOfMs must be a millisecond timestamp"}, readback=False)
            self.write("POST", "/v1/admin/journal/echo/sweep?token=" + ADMIN + "&sinceMs=" + query, {}, 400,
                       error={"error": "sinceMs must be a millisecond timestamp"}, readback=False)
        for value in ({"sinceMs": -1}, {"sinceMs": 0.5}):
            self.write("POST", "/v1/admin/journal/echo/sweep", value, 400, headers={"x-admin-token": ADMIN},
                       error={"error": "sinceMs must be a millisecond timestamp"}, readback=False)
        self.write("POST", "/v1/admin/journal/echo/sweep?sinceMs=1&rejudge=true", {}, headers={"x-admin-token": ADMIN})
        self.write("POST", "/v1/journal/transcribe", b"audio", 503, error={"error": "voice is not available right now"})
        self.write("POST", "/v1/journal/transcribe", b"audio", 403,
                   headers={"Cookie": "wm_session=journal-differential-" + OTHER}, error={"error": "talk is part of Windmill One"})
        self.armed = True
        self.restart()
        self.write("PATCH", "/v1/journal/nudge", {"enabled": True})
        settings = self.pair("GET", "/v1/journal/nudge", expected=200)
        assert settings["armed"] and settings["enabled"] and not settings["suppressed"], settings
        self.write("POST", "/v1/admin/journal/nudge/sweep", {"asOfMs": self.clock_ms}, 409,
                   headers={"x-admin-token": ADMIN}, error={"error": "asOfMs is refused while nudges are enabled"})
        self.webhook()
        settings = self.pair("GET", "/v1/journal/nudge", expected=200)
        assert settings["suppressed"], settings
        self.write("PATCH", "/v1/journal/nudge", {"enabled": True})

    def webhook(self, frozen=False):
        body = json.dumps({"type": "email.bounced", "data": {"to": ["journal-diff@example.com"],
            "bounce": {"type": "Permanent"}}}, separators=(",", ":")).encode()
        identifier = "journal-differential-bounce"
        timestamp = str(self.clock_ms // 1000)
        signed = identifier.encode() + b"." + timestamp.encode() + b"." + body
        signature = "v1," + base64.b64encode(hmac.new(WEBHOOK_KEY, signed, hashlib.sha256).digest()).decode()
        self.write("POST", "/v1/resend/webhook", body, 503 if frozen else 200,
            headers={"svix-id": identifier, "svix-timestamp": timestamp, "svix-signature": signature},
            error={"error": "journal-frozen"} if frozen else {"received": True}, readback=False)

    def refusals(self):
        signed_out = {"Cookie": ""}
        for method, target, body in (("PUT", "/v1/journal/page/bad", b"not json"),
                ("GET", "/v1/journal/page/bad", None), ("GET", "/v1/journal/pages?since=bad", None),
                ("GET", "/v1/journal/export", None), ("PATCH", "/v1/journal/nudge", []),
                ("POST", "/v1/journal/transcribe", b"audio")):
            self.pair(method, target, body, 401, signed_out)
        for method, route in sorted(self.declared):
            if not route.startswith("/v1/journal/") or route.endswith(("/pause", "/unsubscribe")):
                continue
            self.pair(method, re.sub(r"\{[^}]+\}", "bad", route), {}, 401, signed_out)
        self.pair("GET", "/v1/journal/page/2026-07-31", expected=404, error={"error": "nothing written"})
        self.pair("GET", "/v1/journal/pages?since=bad", expected=400, error={"error": "bad cursor"})
        self.pair("GET", "/v1/journal/pages?from=bad&to=2026-01-01", expected=400, error={"error": "bad date"})
        self.pair("GET", "/v1/journal/echoes?from=bad", expected=400, error={"error": "bad date"})
        self.pair("GET", "/v1/admin/journal/echo/explain/bad?token=" + ADMIN, expected=400, error={"error": "bad date"})
        self.pair("GET", "/v1/admin/journal/echo/explain/2026-01-02?token=" + ADMIN, expected=401,
                  headers=signed_out, error={"error": "sign in as the owner of the page"})
        self.pair("GET", "/v1/sync/hello", expected=404)

    def unadopted(self):
        database = self.databases[1][1]
        digest = hashlib.sha256(b"journal-differential-unadopted").hexdigest()
        self.sql(database, f"INSERT INTO users(id,email,name) VALUES ('{UNADOPTED}','journal-unadopted@example.com','Unadopted'); "
            f"INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('{digest}','{UNADOPTED}',99999999999999); "
            f"INSERT INTO journal_page(user_id,day,body) VALUES ('{UNADOPTED}','2026-08-01','Unadopted history')")
        before = self.snapshot(database)
        for retry in range(2):
            response = self.request(1, "PUT", "/v1/journal/page/2026-08-01", {"body": "Refused", "stamp": "1:0:rest"},
                {"Cookie": "wm_session=journal-differential-unadopted"})
            assert response[0] == 503 and json.loads(response[2]) == NOT_ADOPTED, response
        assert before == self.snapshot(database), "unadopted refusal mutated its scope"
        self.binary("windmill_journal_backfill", {"DATABASE_URL": database}, "--account", UNADOPTED)

    def revision_parity(self):
        query = "SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY day,stamp_ms,stamp_counter,stamp_actor,body,superseded_at)::text,'[]') FROM " \
            "(SELECT day,body,stamp_ms,stamp_counter,stamp_actor,superseded_at FROM journal_page_revision " \
            f"WHERE user_id='{ACCOUNT}') r"
        projections = [self.sql(database, query) for _, database in self.databases]
        assert projections[0] == projections[1], "retained revision projection differs"
        rows = json.loads(projections[0])
        assert sum(row["day"] == "2026-08-01" for row in rows) == 10, rows
        assert all(row["body"] != "Expired retained history" for row in rows), rows

    def freeze_sequence(self):
        self.frozen = True
        self.restart()
        before = [self.snapshot(database) for _, database in self.databases]
        for method, route in sorted(self.declared):
            if method == "GET":
                continue
            target = re.sub(r"\{[^}]+\}", "2026-01-01", route)
            self.write(method, target, {}, 503, headers={"Cookie": "", "x-admin-token": "wrong"},
                       error=FROZEN, readback=False)
        self.webhook(frozen=True)
        for account in (ACCOUNT, OTHER, BLANK, REVISIONS):
            self.readback(account)
        self.pagination()
        assert before == [self.snapshot(database) for _, database in self.databases], "freeze allowed a writer"
        writes = {(method, route) for method, route in self.declared if method != "GET"}
        assert self.freeze_covered == writes, ("uncovered freeze doors", writes - self.freeze_covered)

    def sequence(self):
        for account in (ACCOUNT, OTHER, BLANK, REVISIONS):
            self.readback(account)
        self.pagination()
        if self.args.mode == "off-vs-on":
            self.unadopted()
        else:
            self.equal_hlc_sequence()
        self.refusals()
        self.page_sequence()
        self.deferred_sequence()
        self.revision_parity()
        if self.args.mode == "off-vs-on":
            audit = self.binary("windmill_journal_backfill", {"DATABASE_URL": self.databases[1][1]}, "--audit-current")
            (self.directory / "admitted-audit.jsonl").write_bytes(audit)
            rows = [json.loads(line) for line in audit.splitlines()]
            assert rows and all(row["audit"] and row["bootAudit"] and row["computedDigest"] == row["digest"]
                               and row["greatestSeq"] == row["seq"] for row in rows), rows
            self.freeze_sequence()
        assert self.covered == self.declared, ("uncovered journal doors", self.declared - self.covered)
        writes = {(method, route) for method, route in self.declared if method != "GET"}
        return {"mode": self.args.mode, "pairedRequests": self.count, "writeScenarios": self.writes,
                "readRequests": self.reads, "writeRoutes": len(writes), "readRoutes": len(self.declared) - len(writes),
                "allowedDifferences": 0, "unadoptedRefusals": 2 if self.args.mode == "off-vs-on" else 0,
                "equalHlcCohorts": self.equal_hlc_cohorts}


def main():
    parser = argparse.ArgumentParser(description="Real journal REST main/off/on write differential; owns and drops its databases and servers")
    parser.add_argument("--bin-dir", type=Path, default=BACKEND / "build")
    parser.add_argument("--image", help="CI builder image; use docker host networking for both servers and backfill")
    parser.add_argument("--mode", choices=("main-vs-off", "off-vs-on"), default="off-vs-on")
    parser.add_argument("--drogon-prefix", type=Path, help="reuse the pinned Drogon for the origin/main build")
    parser.add_argument("--jobs", type=int, default=8)
    parser.add_argument("--maintenance-db", default=os.environ.get("DATABASE_URL", "postgresql:///postgres?host=/tmp"))
    args = parser.parse_args()
    if args.image and args.mode == "main-vs-off":
        parser.error("main-vs-off requires local builds, not --image")
    if not args.image:
        args.bin_dir = args.bin_dir.resolve()
    directory = Path(tempfile.mkdtemp(prefix="journal-write-differential-"))
    differential = JournalDifferential(args, directory)
    def stop(signum, frame):
        raise KeyboardInterrupt("termination requested")
    signal.signal(signal.SIGTERM, stop)
    try:
        differential.setup()
        report = differential.sequence()
        (directory / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    except BaseException:
        print(json.dumps({"evidence": str(directory)}, sort_keys=True), file=sys.stderr)
        raise
    finally:
        differential.cleanup()
    print(json.dumps({**report, "evidence": str(directory)}, sort_keys=True))


if __name__ == "__main__":
    main()
