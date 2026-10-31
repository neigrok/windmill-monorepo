import argparse
import base64
import http.client
import json
import os
from pathlib import Path
import secrets
import struct
import subprocess
import threading
import time
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import coach_live
from gym_http import gym_headers


def photo_bytes(maximum=False):
    source = (Path(__file__).parent / "fixtures" / "coach_program.png").read_bytes()
    if not maximum:
        return source
    padding = b"Fixture\x00" + b"x" * (1024 * 1024 - len(source) - 12 - len(b"Fixture\x00"))
    chunk = b"tEXt" + padding
    return source[:-12] + struct.pack(">I", len(padding)) + chunk + struct.pack(">I", zlib.crc32(chunk)) + source[-12:]


def fixture_result(details):
    days = [
        [("back-squat", 3, 5), ("bench-press", 3, 8), ("barbell-row", 3, 8)],
        [("deadlift", 2, 5), ("overhead-press", 3, 8), ("lat-pulldown", 3, 10)],
        [("back-squat", 3, 8), ("bench-press", 3, 5), ("barbell-row", 3, 10)],
    ]
    count = min(details.get("daysPerWeek", 2), 3)
    result = {"routines": [{"name": "Training " + str(index + 1), "entries": [
        {"exerciseId": exercise, "sets": [{"reps": reps, "weightKg": None} for _ in range(sets)], "restSeconds": None}
        for exercise, sets, reps in day]} for index, day in enumerate(days[:count])]}
    if details.get("mode") == "conversation":
        if details.get("text") == "fixture_account_required":
            return {"message": "", "routines": [], "errorCode": "account_required"}
        if "routine" not in details.get("text", "").lower():
            return {"message": "Hello. What would you like to work on?" if not details.get("context") else "Three days gives us room to build gradually. Would you like a routine draft?", "routines": [], "errorCode": None}
        result["message"] = "Here are your routine drafts. Review them before saving."
        result["errorCode"] = None
    return result


def fixture(evidence, port):
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            raw_request = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            request = json.loads(raw_request)
            content = request["messages"][0]["content"]
            details = json.loads(content if isinstance(content, str) else next(block["text"] for block in content if block["type"] == "text"))
            images = [block for block in content if block.get("type") == "image"] if isinstance(content, list) else []
            with lock:
                with (evidence / "provider-metadata.jsonl").open("a") as out:
                    out.write(json.dumps({"model": request["model"], "maxTokens": request["max_tokens"],
                                          "mode": details["mode"], "imageCount": len(images),
                                          "requestBytes": len(raw_request),
                                          "imageBytes": [len(base64.b64decode(image["source"]["data"])) for image in images]}) + "\n")
            if details.get("program") == "fixture_transport":
                self.send_response(503)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            result = fixture_result(details)
            stop = "max_tokens" if details.get("program") == "fixture_truncated" else "end_turn"
            raw = json.dumps({"stop_reason": stop, "content": [{"type": "text", "text": json.dumps(result)}],
                              "usage": {"input_tokens": 1000, "output_tokens": min(100 if not result["routines"] else 1000, request["max_tokens"]),
                                        "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *_):
            pass

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


class AnonymousCoachProof(coach_live.LiveCoachProof):
    def __init__(self, evidence, database, provider):
        super().__init__(evidence, database)
        self.provider = provider
        self.results = {"provider": provider, "model": "claude-sonnet-5", "maxOutputTokens": 2000,
                        "generations": [], "checks": {}}
        self.credentials = []

    def call(self, method, path, body=None, credential=None, account=None):
        connection = http.client.HTTPConnection("127.0.0.1", 8088, timeout=30)
        headers = {"Content-Type": "application/json", **gym_headers(path)}
        if credential:
            headers["X-Windmill-Installation"] = credential
        if account:
            headers["Authorization"] = "Bearer " + self.accounts[account]["token"]
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        raw = response.read()
        value = json.loads(raw) if raw and "json" in response.getheader("Content-Type", "") else raw
        result = response.status, value, {name.lower(): value for name, value in response.getheaders()}
        connection.close()
        return result

    def install(self, label):
        status, body, headers = self.call("POST", "/v1/ai/installations", {})
        self.check("installation_" + label, status == 201 and body.get("allowance", {}).get("limit") == "0.050000000" and headers.get("cache-control") == "no-store")
        self.credentials.append(body["credential"])
        return body["credential"]

    def generate(self, label, credential, payload, expected="completed"):
        payload = dict(payload, requestId=str(uuid.uuid4()))
        before = self.usage()["rounds"]
        status, body, headers = self.call("POST", "/v1/gym/coach/onboarding", payload, credential)
        self.check("accepted_" + label, status in (200, 202) and body.get("status") in ("pending", "failed") and headers.get("cache-control") == "private, no-store")
        deadline = time.monotonic() + 420
        while body.get("status") == "pending" and time.monotonic() < deadline:
            time.sleep(0.5)
            status, body, _ = self.call("GET", "/v1/gym/coach/onboarding/" + payload["requestId"], credential=credential)
        self.results["generations"].append({"case": label, "status": body.get("status"), "code": body.get("errorCode"),
                                             "routineCount": len(body.get("routines", [])), "allowance": body.get("allowance"),
                                             "usageAfter": self.usage()})
        self.check("terminal_" + label, status == 200 and body.get("status") == expected)
        self.check("lifetime_bound_" + label, self.usage()["costNanos"] <= 150_000_000)
        self.check("individual_actual_bound_" + label, self.sql("SELECT coalesce(sum(actual_nanos),0)<=50000000 FROM ai_budget_reservations WHERE subject_id=(SELECT device_id FROM gym_coach_onboarding WHERE request_id='" + payload["requestId"] + "')") == "t")
        self.check("no_debt_" + label, self.sql("SELECT count(*) FROM ai_budget_balances WHERE debt_nanos<>0") == "0")
        original = body
        status, replay, _ = self.call("POST", "/v1/gym/coach/onboarding", payload, credential)
        self.check("durable_replay_" + label, status == 200 and replay["resultId"] == original["resultId"] and replay["status"] == original["status"] and replay["routines"] == original["routines"] and replay.get("message") == original.get("message") and replay["errorCode"] == original["errorCode"])
        expected_rounds = before + (0 if expected == "failed" and body.get("errorCode") in ("free_day_exhausted", "free_month_exhausted") else 1)
        deadline = time.monotonic() + 5
        while self.usage()["rounds"] < expected_rounds and time.monotonic() < deadline:
            time.sleep(0.1)
        self.check("one_provider_round_" + label, self.usage()["rounds"] == expected_rounds)
        return payload, body

    def run(self):
        initial_users = int(self.sql("SELECT count(*) FROM users"))
        seeds = set(json.loads(self.sql("SELECT json_agg(id) FROM gym_exercises WHERE created_by IS NULL")))
        issued = {}
        generations = {}
        payloads = {
            "goal": {"mode": "goal", "goal": "ANONYMOUS_PRIVATE_CANARY. Build general strength with three distinct reusable full-body routines, one for each of my three weekly gym days. I am a beginner with no injuries. Keep each routine to four exercises and three sets per exercise.", "daysPerWeek": 3, "equipment": "gym"},
            "program": {"mode": "program", "program": "Two gym days per week. Day A: Back Squat 3x5, Bench Press 3x8, Barbell Row 3x8. Day B: Deadlift 2x5, Overhead Press 3x8, Lat Pulldown 3x10. Weights and rest are not prescribed. Preserve these two routines exactly."},
            "photo": {"mode": "photo", "image": {"mimeType": "image/png", "data": base64.b64encode(photo_bytes(self.provider == "fixture")).decode()}, "note": "Preserve the two workout days exactly. Do not invent weights."},
        }
        for label, payload in payloads.items():
            issued[label] = self.install(label)
            request, result = self.generate(label, issued[label], payload)
            generations[label] = (request, result)
            self.check("known_exercises_" + label, all(line["exerciseId"] in seeds for day in result["routines"] for line in day["entries"]))
            self.check("no_invented_weights_" + label, all(target["weightKg"] is None for day in result["routines"] for line in day["entries"] for target in line["sets"]))
            self.check("balanced_usage_" + label, float(result["allowance"]["used"]) > 0 and result["allowance"]["reserved"] == "0.000000000" and float(result["allowance"]["remaining"]) >= 0)
            if label == "goal":
                self.check("three_reusable_goal_routines", len(result["routines"]) == 3 and all(3 <= len(day["entries"]) <= 6 for day in result["routines"]))
            else:
                observed = [[(line["exerciseId"], [target["reps"] for target in line["sets"]]) for line in day["entries"]] for day in result["routines"]]
                self.check("exact_source_" + label, sorted(observed) == sorted([
                    [("back-squat", [5, 5, 5]), ("bench-press", [8, 8, 8]), ("barbell-row", [8, 8, 8])],
                    [("deadlift", [5, 5]), ("overhead-press", [8, 8, 8]), ("lat-pulldown", [10, 10, 10])]]))
        self.check("no_account_creation", int(self.sql("SELECT count(*) FROM users")) == initial_users)
        self.check("no_account_gym_writes_or_images", self.sql("SELECT (SELECT count(*) FROM gym_routines)+(SELECT count(*) FROM gym_sessions)+(SELECT count(*) FROM gym_ask_threads)+(SELECT count(*) FROM gym_ask_attachments)+(SELECT count(*) FROM gym_notes)+(SELECT count(*) FROM gym_write_receipts)") == "0")
        self.check("only_digest_and_result_persist", self.sql("SELECT count(*) FROM gym_coach_onboarding WHERE length(input_hash)<>64 OR payload::text LIKE '%ANONYMOUS_PRIVATE_CANARY%' OR payload::text LIKE '%base64%'") == "0")
        own_request, own_result = generations["goal"]
        status, hidden, _ = self.call("GET", "/v1/gym/coach/onboarding/" + own_request["requestId"], credential=issued["program"])
        status_missing, missing, _ = self.call("GET", "/v1/gym/coach/onboarding/" + str(uuid.uuid4()), credential=issued["program"])
        self.check("private_result_scope", status == status_missing == 404 and hidden == missing)
        status, conflict, _ = self.call("POST", "/v1/gym/coach/onboarding", dict(own_request, goal="Changed goal"), issued["goal"])
        self.check("immutable_request", status == 409 and conflict.get("code") == "request_conflict")
        status, invalid, _ = self.call("POST", "/v1/gym/coach/onboarding", {"requestId": str(uuid.uuid4()), "mode": "photo", "image": {"mimeType": "image/png", "data": "AAAA"}}, issued["photo"])
        self.check("invalid_photo_before_claim", status == 400 and invalid.get("code") == "invalid_image" and self.sql("SELECT count(*) FROM gym_coach_onboarding") == "3")
        if self.provider == "fixture":
            _, greeting = self.generate("greeting", issued["program"], {"mode": "conversation", "text": "Hi", "context": []})
            self.check("greeting_without_routines", greeting["message"] == "Hello. What would you like to work on?" and greeting["routines"] == [])
            context = [{"role": "user", "text": "Hi"}, {"role": "assistant", "text": greeting["message"]}]
            _, followup = self.generate("followup", issued["program"], {"mode": "conversation", "text": "I can train three days each week", "context": context})
            self.check("dialogue_followup_without_routines", followup["message"] == "Three days gives us room to build gradually. Would you like a routine draft?" and followup["routines"] == [])
            context += [{"role": "user", "text": "I can train three days each week"}, {"role": "assistant", "text": followup["message"]}]
            _, draft = self.generate("dialogue_draft", issued["program"], {"mode": "conversation", "text": "Yes, draft a routine", "context": context})
            self.check("dialogue_draft_not_imported", bool(draft["routines"]) and self.sql("SELECT count(*) FROM gym_routines") == "0")
            _, policy = self.generate("account_required", issued["program"], {"mode": "conversation", "text": "fixture_account_required", "context": []}, expected="failed")
            self.check("typed_account_required_without_account_writes", policy["errorCode"] == "account_required" and policy["message"] == "" and policy["routines"] == [] and
                       all(self.sql("SELECT count(*) FROM " + table) == "0" for table in ("gym_routines", "gym_notes", "gym_proposals")))
        for path in ("/v1/gym/threads", "/v1/gym/exercises", "/v1/gym/routines", "/v1/gym/threads/thr_private/attachments/img_private"):
            status, _, _ = self.call("GET", path, credential=issued["goal"])
            self.check("account_route_locked_" + path.split("/")[-1], status == 401)
        status, _, _ = self.call("POST", "/v1/gym/ask", {"thread": "thr_private", "question": "Read my account"}, issued["goal"])
        self.check("full_coach_locked", status == 401)
        status, bound, _ = self.call("POST", "/v1/ai/installations/bind", {}, issued["goal"], "free")
        self.check("verified_bind_and_attribution", status == 200 and bound.get("bound") and bound["allowance"]["used"] == own_result["allowance"]["used"] and bound["allowance"]["limit"] == "0.250000000")
        status, current, _ = self.call("GET", "/v1/ai/installations/current", credential=issued["goal"])
        self.check("permanent_binding", status == 200 and current["bound"])
        status, _, _ = self.call("POST", "/v1/gym/coach/onboarding", dict(own_request, requestId=str(uuid.uuid4())), issued["goal"])
        self.check("signup_cannot_reopen_trial", status == 409)
        status, restored, _ = self.call("GET", "/v1/gym/coach/onboarding/" + own_request["requestId"], credential=issued["goal"])
        self.check("bound_result_still_readable", status == 200 and restored["routines"] == own_result["routines"])
        self.check("exact_reservation_settlement", self.sql("SELECT (SELECT coalesce(sum(actual_nanos),0) FROM ai_budget_reservations) = (SELECT coalesce(sum(cost_nanos),0) FROM ai_usage)") == "t")
        self.check("anonymous_cost_subjects_only", self.sql("SELECT count(*) FROM ai_budget_reservations WHERE subject_kind<>'device' OR tier<>'anonymous'") == "0" and self.sql("SELECT count(*) FROM ai_usage WHERE user_id IS NOT NULL OR operation<>'coach.preview'") == "0")
        free_spend = int(self.sql("SELECT coalesce(sum(actual_nanos),0) FROM ai_budget_reservations"))
        pools = json.loads(self.sql("SELECT json_object_agg(scope,spent_nanos) FROM ai_budget_balances WHERE scope IN('free_day','free_month')"))
        self.check("shared_free_global_pools", pools == {"free_day": free_spend, "free_month": free_spend})
        if self.provider == "fixture":
            metadata = [json.loads(line) for line in (self.evidence / "provider-metadata.jsonl").read_text().splitlines()]
            self.check("maximum_photo_forwarded_inline", any(row["mode"] == "photo" and row["imageBytes"] == [1024 * 1024] for row in metadata))
            for label, failure in (("truncated", "output_truncated"), ("transport", "provider_failed")):
                credential = self.install(label)
                _, result = self.generate(label, credential, {"mode": "program", "program": "fixture_" + label}, "failed")
                self.check("failure_" + label, result["errorCode"] == failure and result["routines"] == [])
            self.check("unknown_charge_keeps_hold", self.sql("SELECT count(*) FROM ai_budget_reservations WHERE state='uncertain' AND actual_nanos IS NULL") == "1")
            credential = self.install("free_pause")
            prior_day_spend = int(self.sql("SELECT spent_nanos FROM ai_budget_balances WHERE scope='free_day'"))
            self.sql("UPDATE ai_budget_balances SET spent_nanos=5000000000 WHERE scope='free_day'")
            try:
                _, paused = self.generate("free_pause", credential, payloads["goal"], "failed")
                self.check("global_pause_reset", paused["errorCode"] == "free_day_exhausted" and paused["allowance"]["code"] == "free_day_exhausted" and paused["allowance"]["budgetResetsAtMs"] > int(time.time() * 1000))
            finally:
                self.sql(f"UPDATE ai_budget_balances SET spent_nanos={prior_day_spend} WHERE scope='free_day'")
        actions = ["review_routines", "routines_saved", "keep_routines", "photo_selected", "photo_removed", "open_routine"]
        events = [{"id": "evt_" + uuid.uuid4().hex, "name": "gym_setup_step", "clientMs": int(time.time()*1000), "props": {"screen": "coach", "action": action}} for action in actions]
        status, accepted, _ = self.call("POST", "/v1/events", {"sessionKey": "anonymous-coach-proof", "platform": "ios", "events": events})
        self.check("first_party_events", status == 202 and accepted.get("accepted") == len(actions))
        for _ in range(45):
            records = (self.evidence / "observer.jsonl").read_text() if (self.evidence / "observer.jsonl").exists() else ""
            if all(name in records for name in actions + ["gym_setup_step", "gym.coach.onboarding.generate", "ai.call.account", "ai.installation.bind"]):
                break
            time.sleep(1)
        self.check("write_and_event_delivery", all(name in records for name in actions + ["gym_setup_step", "gym.coach.onboarding.generate", "ai.call.account", "ai.installation.bind"]))
        self.check("telemetry_contains_no_private_content", "ANONYMOUS_PRIVATE_CANARY" not in records and "MY TWO-DAY TRAINING PLAN" not in records and all(secret not in records for secret in self.credentials + [account["token"] for account in self.accounts.values()]))
        issues = sum(json.loads(line).get("type") == "event" for row in records.splitlines() for line in json.loads(row)["body"].splitlines() if line.startswith("{") and "/envelope" in json.loads(row)["path"])
        self.check("failure_reporting", issues == (2 if self.provider == "fixture" else 0))
        self.collect_diagnostics()
        self.check("one_reservation_per_call", len(self.results["reservations"]) == len(self.results["rounds"]))
        self.results["completed"] = True
        self.save()
        print(json.dumps({"completed": True, "checks": len(self.results["checks"]), "actualCost": self.results["actualCost"]}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "observe", "fixture", "verify"])
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--database", default=os.environ.get("DATABASE_URL", ""))
    parser.add_argument("--provider", choices=["fixture", "anthropic"], default="fixture")
    parser.add_argument("--mail-port", type=int, default=443)
    parser.add_argument("--port", type=int, default=8097)
    args = parser.parse_args()
    if args.mode == "observe":
        coach_live.observe(args.evidence, args.mail_port)
        return
    if args.mode == "fixture":
        fixture(args.evidence, args.port)
        return
    database = subprocess.run(["psql", args.database, "-X", "-A", "-t", "-c", "SELECT current_database()"], check=True, capture_output=True, text=True).stdout.strip()
    if not (database.startswith("wm_anonymous_coach_") or database == "anonymous_coach_live"):
        raise SystemExit("Use an isolated anonymous Coach verification database.")
    if args.mode == "prepare":
        coach_live.prepare(args.evidence, args.database)
        (args.evidence / "installation-key").write_text(secrets.token_hex(32))
        (args.evidence / "installation-key").chmod(0o600)
        return
    proof = AnonymousCoachProof(args.evidence, args.database, args.provider)
    try:
        proof.run()
    except Exception as error:
        time.sleep(6)
        proof.results["completed"] = False
        proof.results["failureType"] = type(error).__name__
        proof.results["failureStage"] = proof.stage
        try:
            proof.collect_diagnostics()
        except Exception as diagnostic_error:
            proof.results["diagnosticFailureType"] = type(diagnostic_error).__name__
        proof.save()
        print("Anonymous Coach verification failed; inspect the bounded results artifact.")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
