import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class LiveCoachProof:
    def __init__(self, evidence, database):
        self.evidence = evidence
        self.database = database
        self.accounts = json.loads((evidence / "accounts.json").read_text())
        self.results = {"provider": "Anthropic", "model": "claude-opus-5", "maxOutputTokens": 2000,
                        "generations": [], "checks": {}}
        self.stage = "initial_allowance"

    def sql(self, statement):
        result = subprocess.run(["psql", self.database, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement],
                                check=True, capture_output=True, text=True)
        return result.stdout.strip()

    def request(self, method, path, body=None, role="free", media="application/json"):
        connection = http.client.HTTPConnection("127.0.0.1", 8088, timeout=330)
        headers = {"Content-Type": media}
        if role:
            headers["Authorization"] = "Bearer " + self.accounts[role]["token"]
        data = body if isinstance(body, bytes) else json.dumps(body) if body is not None else None
        connection.request(method, path, data, headers)
        response = connection.getresponse()
        raw = response.read()
        value = json.loads(raw) if raw and "json" in response.getheader("Content-Type", "") else raw
        result = response.status, value, {name.lower(): value for name, value in response.getheaders()}
        connection.close()
        return result

    def usage(self):
        return json.loads(self.sql("SELECT json_build_object('rounds',count(*),'costNanos',coalesce(sum(cost_nanos),0),"
                                   "'unpriced',count(*) FILTER (WHERE cost_nanos IS NULL),'failed',count(*) FILTER "
                                   "(WHERE outcome <> 'ok')) FROM ai_usage"))

    def check(self, name, condition):
        self.stage = name
        self.results["checks"][name] = bool(condition)
        self.save()
        if not condition:
            raise RuntimeError("verification failed: " + name)

    def save(self):
        (self.evidence / "results.json").write_text(json.dumps(self.results, indent=2))

    def collect_diagnostics(self):
        diagnostics = []
        source = self.evidence / "observer.jsonl"
        for record in source.read_text().splitlines() if source.exists() else []:
            envelope = json.loads(record)
            if "/envelope" not in envelope["path"]:
                continue
            for line in envelope["body"].splitlines():
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for item in payload.get("items", []) if isinstance(payload, dict) else []:
                    _, marker, data = item.get("body", "").partition("anthropic_stream_diagnostic=")
                    if marker:
                        diagnostic, _ = json.JSONDecoder().raw_decode(data)
                        diagnostics.append({name: value for name, value in diagnostic.items()
                            if name in {"httpStatus", "curlCode", "providerError", "parserFailure", "messageStarted", "messageComplete", "cancelled", "callbackFailed"}})
        self.results["providerDiagnostics"] = diagnostics

    def ask(self, role, label, thread, question, attachments=None):
        self.stage = label
        self.check("generation_bound_" + label, len(self.results["generations"]) < 3)
        self.check("cost_before_" + label, self.usage()["costNanos"] < 750_000_000)
        payload = {"thread": thread, "requestId": "req_" + uuid.uuid4().hex, "purpose": "routine_setup", "question": question}
        if attachments:
            payload["attachmentIds"] = attachments
        answer = []
        errors = []
        def send():
            try:
                answer.append(self.request("POST", "/v1/gym/ask", payload, role))
            except Exception:
                errors.append("ask_transport_failure")
        worker = threading.Thread(target=send, daemon=True)
        worker.start()
        started = time.monotonic()
        stopped = False
        while worker.is_alive():
            worker.join(1)
            if not stopped and (time.monotonic() - started > 270 or self.usage()["costNanos"] >= 900_000_000):
                stopped = True
                self.request("POST", f"/v1/gym/threads/{thread}/generations/{payload['requestId']}/stop", {}, role)
        self.check("transport_" + label, not errors and bool(answer) and not stopped)
        status, reply, _ = answer[0]
        self.results["generations"].append({"case": label, "status": status,
            "outcome": reply.get("generation", {}).get("status"), "code": reply.get("code"),
            "routineCount": len(reply.get("results", [])), "usageAfter": self.usage()})
        self.check("completed_" + label, status == 200 and reply.get("generation", {}).get("status") == "completed")
        self.check("cost_after_" + label, self.usage()["costNanos"] < 1_000_000_000)
        self.check("no_failed_provider_round_" + label, self.usage()["failed"] == 0 and self.usage()["unpriced"] == 0)
        return payload, reply

    def run(self):
        for role, tier, limit in [("free", "logged_in", "0.250000000"), ("owner", "windmill_one", "7.000000000")]:
            status, allowance, headers = self.request("GET", "/v1/ai/allowance", role=role)
            self.check("fresh_allowance_" + role, status == 200 and allowance["tier"] == tier and
                       allowance["limit"] == limit and allowance["used"] == "0.000000000" and headers["cache-control"] == "no-store")
        goal_thread = "thr_" + uuid.uuid4().hex
        _, goal = self.ask("free", "free_goal", goal_thread,
            "COACH_LIVE_PRIVATE_CANARY. I want to get stronger with a simple plan. Help me choose my weekly days and equipment before making routines.")
        clarification = goal["generation"].get("clarification", {})
        self.check("typed_days_and_equipment", {group["id"] for group in clarification.get("groups", [])} == {"days", "equipment"})
        status, history, _ = self.request("GET", "/v1/gym/threads/" + goal_thread)
        self.check("clarification_history", status == 200 and history["turns"][-1].get("clarification") == clarification)
        payload, created = self.ask("free", "free_routines", goal_thread,
            "Three days each week, with a full gym. Create exactly two short alternating full-body routines with three movements each and three working sets per movement. Use rep targets and no prescribed weights.")
        self.check("two_free_routines", len(created.get("results", [])) == 2 and all(row.get("movementCount") == 3 for row in created["results"]))
        before = self.usage()
        status, replay, _ = self.request("POST", "/v1/gym/ask", payload)
        self.check("replay_no_provider_cost", status == 200 and replay["results"] == created["results"] and self.usage() == before)
        status, conflict, _ = self.request("POST", "/v1/gym/ask", {**payload, "question": "A different question."})
        self.check("immutable_retry_refusal", status == 409 and conflict.get("code") == "ask-request-conflict" and self.usage() == before)
        status, _, _ = self.request("GET", "/v1/gym/threads/" + goal_thread, role="owner")
        self.check("foreign_history_refused", status == 404)

        photo = (Path(__file__).parent / "fixtures" / "coach_program.png").read_bytes()
        photo_thread, attachment = "thr_" + uuid.uuid4().hex, "img_" + uuid.uuid4().hex
        photo_path = f"/v1/gym/threads/{photo_thread}/attachments/{attachment}"
        status, upload, _ = self.request("PUT", photo_path, photo, "owner", "image/png")
        self.check("photo_upload", status == 200 and upload["attachment"]["bytes"] == len(photo))
        status, replay, _ = self.request("PUT", photo_path, photo, "owner", "image/png")
        self.check("photo_upload_replay", status == 200 and replay == upload)
        status, downloaded, headers = self.request("GET", photo_path, role="owner")
        self.check("photo_private_roundtrip", status == 200 and downloaded == photo and headers.get("cache-control") == "private, no-store")
        for role, expected in [("free", 404), (None, 401)]:
            status, _, _ = self.request("GET", photo_path, role=role)
            self.check("photo_foreign" if role else "photo_anonymous", status == expected)
        _, vision = self.ask("owner", "owner_photo", photo_thread,
            "Turn the program in this picture into the two routines it specifies. Preserve exactly its movements, working-set counts and rep targets, with no prescribed weights. The picture contains my weekly availability and equipment.", [attachment])
        observed = []
        self.check("two_photo_receipts", len(vision.get("results", [])) == 2)
        for receipt in vision["results"]:
            status, routine, _ = self.request("GET", "/v1/gym/routines/" + receipt["routineId"], role="owner")
            self.check("photo_routine_" + str(len(observed)), status == 200 and receipt["movementCount"] == 3)
            day = []
            for entry in routine["entries"]:
                day.append((entry["exerciseId"], [item.get("reps") for item in entry["sets"]]))
                self.check("photo_no_invented_weight_" + entry["exerciseId"], all("weightKg" not in item for item in entry["sets"]))
            observed.append(day)
        self.check("actual_vision_exact_program", sorted(observed) == sorted([
            [("back-squat", [5, 5, 5]), ("bench-press", [8, 8, 8]), ("barbell-row", [8, 8, 8])],
            [("deadlift", [5, 5]), ("overhead-press", [8, 8, 8]), ("lat-pulldown", [10, 10, 10])]]))
        status, history, _ = self.request("GET", "/v1/gym/threads/" + photo_thread, role="owner")
        self.check("photo_history_receipts", status == 200 and history["turns"][-1]["results"] == vision["results"] and
                   history["turns"][-2]["attachments"] == [upload["attachment"]])

        for role in ["free", "owner"]:
            account = self.accounts[role]["account"]
            actual = int(self.sql(f"SELECT coalesce(sum(actual_nanos),0) FROM ai_budget_reservations WHERE subject_id='{account}'"))
            ledger = int(self.sql(f"SELECT coalesce(sum(cost_nanos),0) FROM ai_usage WHERE user_id='{account}'"))
            status, allowance, _ = self.request("GET", "/v1/ai/allowance", role=role)
            self.check("exact_settlement_" + role, status == 200 and actual == ledger and actual > 0 and
                       allowance["used"] == f"{actual // 1000000000}.{actual % 1000000000:09}" and allowance["reserved"] == "0.000000000")
            self.results[role + "Allowance"] = allowance
        self.check("no_uncertain_or_debt", self.sql("SELECT (SELECT count(*) FROM ai_budget_reservations WHERE state <> 'settled') + (SELECT count(*) FROM ai_budget_balances WHERE debt_nanos <> 0)") == "0")
        self.results["rounds"] = json.loads(self.sql("SELECT coalesce(json_agg(json_build_object('model',model,'input',input_tokens,'output',output_tokens,'cacheRead',cache_read_tokens,'cacheWrite',cache_write_tokens,'costNanos',cost_nanos) ORDER BY id),'[]') FROM ai_usage"))
        self.check("actual_output_cap", all(row["output"] <= 2000 for row in self.results["rounds"]))
        free_account = self.accounts["free"]["account"]
        free_spend = int(self.sql(f"SELECT coalesce(sum(actual_nanos),0) FROM ai_budget_reservations WHERE subject_id='{free_account}'"))
        pools = json.loads(self.sql("SELECT coalesce(json_object_agg(scope, spent_nanos),'{}') FROM ai_budget_balances WHERE scope IN ('free_day','free_month')"))
        self.check("paid_free_pool_separation", pools == {"free_day": free_spend, "free_month": free_spend})
        self.results["actualCost"] = self.usage()
        events = [{"id": "evt_" + uuid.uuid4().hex, "name": "gym_setup_step", "clientMs": int(time.time() * 1000),
                   "props": {"screen": "coach", "action": action}} for action in ["shown", "goal", "clarify", "screenshot", "open_routine"]]
        status, accepted, _ = self.request("POST", "/v1/events", {"sessionKey": "coach-live-verification", "platform": "ios", "events": events})
        self.check("first_party_events", status == 202 and accepted["accepted"] == 5)
        for _ in range(30):
            records = (self.evidence / "observer.jsonl").read_text() if (self.evidence / "observer.jsonl").exists() else ""
            if "gym_setup_step" in records and "ai.call.account" in records and "ask.run" in records:
                break
            time.sleep(1)
        self.check("amplitude_delivery", "gym_setup_step" in records)
        self.check("sentry_write_logs", "ai.call.account" in records and "ask.run" in records)
        self.check("private_content_absent", "COACH_LIVE_PRIVATE_CANARY" not in records and "MY TWO-DAY TRAINING PLAN" not in records and all(a["token"] not in records for a in self.accounts.values()))
        issue_count = 0
        for record in records.splitlines():
            envelope = json.loads(record)
            if "/envelope" not in envelope["path"]:
                continue
            for line in envelope["body"].splitlines():
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict) and item.get("type") == "event":
                    issue_count += 1
        self.check("no_sentry_issues", issue_count == 0)
        self.collect_diagnostics()
        self.results["completed"] = True
        self.save()
        print(json.dumps({"completed": True, "generations": 3, "actualCost": self.results["actualCost"]}))


def prepare(evidence, database):
    evidence.mkdir(parents=True, exist_ok=True)
    evidence.chmod(0o700)
    accounts = {}
    for role in ["free", "owner"]:
        token, account = secrets.token_hex(32), str(uuid.uuid4())
        email = "coach-live-" + role + "@example.com"
        accounts[role] = {"account": account, "token": token, "email": email}
        statement = (f"INSERT INTO users(id,email) VALUES('{account}','{email}'); INSERT INTO sessions(token_hash,user_id,expires_ms) "
                     f"VALUES('{hashlib.sha256(token.encode()).hexdigest()}','{account}',{int(time.time()*1000)+3600000});")
        subprocess.run(["psql", database, "-X", "-v", "ON_ERROR_STOP=1", "-q", "-c", statement], check=True, capture_output=True)
    (evidence / "accounts.json").write_text(json.dumps(accounts))
    (evidence / "accounts.json").chmod(0o600)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(evidence / "key.pem"),
                    "-out", str(evidence / "cert.pem"), "-days", "1", "-subj", "/CN=localhost",
                    "-addext", "subjectAltName=DNS:localhost,DNS:api.resend.com,IP:127.0.0.1"], check=True, capture_output=True)
    ca = Path("/etc/ssl/certs/ca-certificates.crt")
    if not ca.exists():
        ca = Path("/etc/ssl/cert.pem")
    (evidence / "ca-bundle.pem").write_bytes(ca.read_bytes() + (evidence / "cert.pem").read_bytes())


def observe(evidence, mail_port):
    lock = threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
            with lock:
                with (evidence / "observer.jsonl").open("a") as out:
                    out.write(json.dumps({"path": self.path, "body": body}) + "\n")
            answer = b'{"id":"local-mail-receipt","code":200}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)
        def log_message(self, *_):
            pass
    servers = []
    for port in ([mail_port] if mail_port else []) + [9443]:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(evidence / "cert.pem", evidence / "key.pem")
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    threading.Event().wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "observe", "verify"])
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--database", default=os.environ.get("DATABASE_URL", ""))
    parser.add_argument("--mail-port", type=int, default=443)
    args = parser.parse_args()
    if args.mode == "prepare":
        prepare(args.evidence, args.database)
    elif args.mode == "observe":
        observe(args.evidence, args.mail_port)
    else:
        proof = LiveCoachProof(args.evidence, args.database)
        try:
            proof.run()
        except Exception as error:
            time.sleep(6)
            proof.collect_diagnostics()
            proof.results["completed"] = False
            proof.results["failureType"] = type(error).__name__
            proof.results["failureStage"] = proof.stage
            proof.save()
            print("Live Coach verification failed; inspect the bounded results artifact.")
            raise SystemExit(1)


if __name__ == "__main__":
    main()
