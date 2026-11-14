import json
import pathlib
import re
import sys

ROOT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent

DAY = 86_400_000
RENEWAL_SLACK = {"production": DAY, "sandbox": 0}
ENVIRONMENTS = ("production", "sandbox")
STATES = {"active", "grace", "on_hold", "paused", "expired", "revoked"}
ENDED = {"expired", "revoked"}
NO_NEXT_CHARGE = {"grace", "on_hold", "paused", "expired", "revoked"}
STORES = {"app_store", "play_store", "paddle"}
END_REASONS = {"cancelled", "billing", "price_change_declined", "product_unavailable", "replaced", "refunded",
               "chargeback", "sharing_removed", "unknown"}
OFFER_KINDS = {None, "free_trial", "introductory", "promotional", "offer_code", "win_back"}
PERIOD_EVENTS = {"period_recorded", "period_refunded", "period_refund_reversed"}
LIFECYCLE_EVENTS = {"started", "renewed", "renewal_turned_off", "renewal_turned_on", "payment_failed",
                    "payment_recovered", "pause_scheduled", "paused", "resumed", "plan_change_scheduled",
                    "plan_changed", "period_extended", "expired", "revoked", "revocation_reversed", "updated",
                    "bound", "unbound"}
REFUSALS = {409: "bound_to_another_account", 400: "invalid_transaction", 503: "subscriptions_unavailable"}
MANAGE_URL = {"app_store": "https://apps.apple.com/account/subscriptions"}
OFFER = {"aiAllowance": {"amount": "7.00", "currency": "USD"}}

SUBSCRIPTION_FIELDS = ["subscriptionId", "store", "state", "startedAt", "currentPeriod", "accessUntil", "autoRenew",
                       "nextChargeAt", "nextCharge", "nextProductId", "cancelRequestedAt", "paymentFailedAt",
                       "graceEndsAt", "pauseScheduledFor", "pausedAt", "resumesAt", "offerKind", "offerEndsAt",
                       "endedAt", "endReason"]
ENTITLEMENT_FIELDS = ["plan", "accessUntil", "governing", "others"]
ENTITLEMENT_RESPONSE_FIELDS = ["accountId", "production", "sandbox"]
SUBSCRIPTION_RESPONSE_FIELDS = ["environment", "allowlisted", "plan", "accessUntil", "governing", "others", "manage",
                                "purchasable", "offer"]
PAGE_FIELDS = ["epoch", "entries", "latestSeq"]
ENTRY_FIELDS = ["seq", "type", "occurredAt", "recordedAt", "subscriptionId", "accountId", "store", "environment",
                "offerKind", "period", "entitlement"]
PERIOD_FIELDS = ["id", "start", "end", "price", "offerKind", "refundedAt"]

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
# ISO 4217 minor units where they are not two; an amount carries exactly its currency's.
MINOR_UNITS = {**dict.fromkeys(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI",
                                "VND", "VUV", "XAF", "XOF", "XPF"], 0),
               **dict.fromkeys(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"], 3),
               **dict.fromkeys(["CLF", "UYW"], 4)}
JWS = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")

FILES = ["entitlement.json", "subscription.json", "feed.json", "app-store-claim.json", "internal-app-store-claim.json"]
loaded = {name: json.loads((ROOT / name).read_text()) for name in FILES}
passed, failed = [], []


def check(holds, claim):
    (passed if holds else failed).append(claim)


def named(file):
    return {example["name"]: example for example in loaded[file]["examples"]}


def amount_pattern(currency):
    minor_units = MINOR_UNITS.get(currency, 2)
    return r"^\d+$" if minor_units == 0 else rf"^\d+\.\d{{{minor_units}}}$"


def check_money(money, where):
    check(set(money) == {"amount", "currency"} and re.match(r"^[A-Z]{3}$", money["currency"])
          and re.match(amount_pattern(money["currency"]), money["amount"]),
          f"{where}: a decimal string amount in its ISO 4217 currency's minor units")


def access_until(subscription, environment):
    if subscription["state"] == "grace":
        return subscription["graceEndsAt"]
    if subscription["state"] == "active":
        end = subscription["currentPeriod"]["end"]
        return end + (RENEWAL_SLACK[environment] if subscription["autoRenew"] else 0)
    return None


def check_subscription(s, environment, where):
    check(list(s) == SUBSCRIPTION_FIELDS, f"{where}: the §5.2 field list, in order ({list(s)})")
    check(s["state"] in STATES and s["store"] in STORES, f"{where}: state and store are §3 values")
    check(set(s["currentPeriod"]) == {"start", "end"} and s["currentPeriod"]["start"] < s["currentPeriod"]["end"],
          f"{where}: currentPeriod is {{start, end}} with start before end")
    check(s["startedAt"] <= s["currentPeriod"]["start"], f"{where}: startedAt is not after the period in force")
    check(s["accessUntil"] == access_until(s, environment), f"{where}: accessUntil is INV-2 in {environment}")
    if not s["autoRenew"] or s["state"] in NO_NEXT_CHARGE:
        check(s["nextChargeAt"] is None and s["nextCharge"] is None, f"{where}: no next charge (§3.1)")
    else:
        check(s["nextChargeAt"] == s["currentPeriod"]["end"], f"{where}: the next charge falls at the period's end")
        check_money(s["nextCharge"], f"{where}.nextCharge")
    check((s["endedAt"] is not None) == (s["state"] in ENDED), f"{where}: endedAt set exactly when it ended")
    check((s["endReason"] is not None) == (s["state"] in ENDED), f"{where}: endReason set exactly when it ended")
    check(s["endReason"] is None or s["endReason"] in END_REASONS, f"{where}: endReason is a §3.1 value")
    check(s["offerKind"] in OFFER_KINDS, f"{where}: offerKind is a §3.1 value")
    if s["cancelRequestedAt"] is not None:
        check(not s["autoRenew"], f"{where}: a cancellation turns renewal off")
    if s["state"] in {"grace", "on_hold"}:
        check(s["paymentFailedAt"] is not None, f"{where}: payment trouble says when the charge failed")
    if s["state"] == "grace":
        check(s["graceEndsAt"] is not None and s["graceEndsAt"] - s["paymentFailedAt"] == 16 * DAY,
              f"{where}: grace lasts 16 days (R-7)")


def check_entitlement(e, environment, where):
    check(list(e) == ENTITLEMENT_FIELDS, f"{where}: an Entitlement is {{plan, accessUntil, governing, others}}")
    governing = e["governing"]
    if governing is None:
        check(e["plan"] is None and e["accessUntil"] is None and e["others"] == [],
              f"{where}: no subscription, no access")
        return
    check_subscription(governing, environment, f"{where}.governing")
    for i, other in enumerate(e["others"]):
        check_subscription(other, environment, f"{where}.others[{i}]")
        check(other["state"] not in ENDED, f"{where}.others[{i}]: not expired or revoked")
        if other["accessUntil"] is not None:
            check(governing["accessUntil"] is not None and (governing["accessUntil"] > other["accessUntil"] or (
                governing["accessUntil"] == other["accessUntil"]
                and governing["subscriptionId"] < other["subscriptionId"])),
                f"{where}: governing grants access longest, ties to the smaller id (§5.2)")
    ids = [other["subscriptionId"] for other in e["others"]]
    check(ids == sorted(ids) and governing["subscriptionId"] not in ids,
          f"{where}: others ordered by subscriptionId, governing not among them")
    check(e["accessUntil"] == governing["accessUntil"], f"{where}: accessUntil is the governing subscription's")
    check(e["plan"] == ("windmill_one" if e["accessUntil"] is not None else None),
          f"{where}: plan is windmill_one exactly while accessUntil is set")


def check_entitlement_response(e, where):
    check(list(e) == ENTITLEMENT_RESPONSE_FIELDS, f"{where}: EntitlementResponse is {{accountId, production, sandbox}}")
    for environment in ENVIRONMENTS:
        check_entitlement(e[environment], environment, f"{where}.{environment}")


def check_subscription_response(r, where):
    check(list(r) == SUBSCRIPTION_RESPONSE_FIELDS, f"{where}: SubscriptionResponse fields, in order")
    check(r["environment"] in ENVIRONMENTS and isinstance(r["allowlisted"], bool),
          f"{where}: environment names the Entitlement shown; allowlisted is a boolean")
    check_entitlement({field: r[field] for field in ENTITLEMENT_FIELDS}, r["environment"], where)
    governing = r["governing"]
    check(r["manage"] == (None if governing is None else {"store": governing["store"],
                                                          "url": MANAGE_URL[governing["store"]]}),
          f"{where}: manage is the governing subscription's store")
    holds_live = (governing is not None and governing["state"] not in ENDED) or bool(r["others"])
    if r["accessUntil"] is not None or holds_live:
        check(r["purchasable"] == [], f"{where}: nothing to buy with access or a live subscription (INV-12)")
    check(set(r["purchasable"]) <= STORES, f"{where}: purchasable names stores")
    check(r["offer"] == (OFFER if r["purchasable"] else None),
          f"{where}: offer is One's AI allowance exactly when there is something to buy (§5.3)")
    if r["environment"] == "sandbox":
        check(r["allowlisted"] and r["accessUntil"] is not None,
              f"{where}: a sandbox Entitlement is shown only to an allowlisted account it grants (§5.3)")


# entitlement.json
entitlements = named("entitlement.json")
for name, example in entitlements.items():
    check_entitlement_response(example["body"], f"entitlement/{name}")
check(entitlements["sandbox_active"]["body"]["production"]["governing"] is None
      and entitlements["sandbox_active"]["body"]["sandbox"]["accessUntil"] is not None,
      "entitlement/sandbox_active: sandbox access lives in the sandbox Entitlement alone (§5.2)")
check(len(entitlements["charged_twice"]["body"]["production"]["others"]) == 1,
      "entitlement/charged_twice: the second subscription is in others")

# subscription.json
responses = named("subscription.json")
for name, example in responses.items():
    check_subscription_response(example["body"], f"subscription/{name}")
expected_purchasable = {
    "active": [], "cancelled_access_continues": [], "grace": [], "on_hold": [], "expired_line_open": ["app_store"],
    "revoked_line_open": ["app_store"], "never_subscribed_line_open": ["app_store"],
    "allowlisted_never_subscribed_line_open": ["app_store"], "never_subscribed_line_closed": [], "charged_twice": [],
    "sandbox_allowlisted": [], "sandbox_not_allowlisted_line_open": ["app_store"]}
check(sorted(responses) == sorted(expected_purchasable), "subscription: every example the README promises, no other")
for name, purchasable in expected_purchasable.items():
    if name in responses:
        check(responses[name]["body"]["purchasable"] == purchasable, f"subscription/{name}: purchasable {purchasable}")
check(responses["revoked_line_open"]["body"]["governing"]["state"] == "revoked", "subscription/revoked_line_open: revoked")
check(responses["charged_twice"]["body"]["others"] != [], "subscription/charged_twice: others is not empty")
check(responses["sandbox_allowlisted"]["body"]["environment"] == "sandbox",
      "subscription/sandbox_allowlisted: shows the sandbox Entitlement")
check(not responses["sandbox_not_allowlisted_line_open"]["body"]["allowlisted"]
      and responses["sandbox_not_allowlisted_line_open"]["body"]["environment"] == "production",
      "subscription/sandbox_not_allowlisted_line_open: production shown; a sandbox build offers nothing (INV-12)")
check(responses["allowlisted_never_subscribed_line_open"]["body"]["allowlisted"],
      "subscription/allowlisted_never_subscribed_line_open: a sandbox build may offer the buy control (INV-12)")

# feed.json: each page alone
feed = named("feed.json")
chain_epoch = feed["from_zero"]["body"]["epoch"]
chained = []
for name, example in feed.items():
    page, request, where = example["body"], example["request"], f"feed/{name}"
    check(list(page) == PAGE_FIELDS, f"{where}: a page is {{epoch, entries, latestSeq}}")
    check(bool(UUID.match(page.get("epoch", ""))), f"{where}: epoch is a UUID")
    check(1 <= request["limit"] <= 500, f"{where}: limit is 1 to 500")
    seqs = [entry["seq"] for entry in page["entries"]]
    check(all(seq > request["after"] for seq in seqs), f"{where}: every seq is after the cursor")
    check(seqs == sorted(set(seqs)) and len(seqs) <= request["limit"], f"{where}: seq increases, within limit")
    check(all(seq <= page["latestSeq"] for seq in seqs), f"{where}: latestSeq is at least every seq")
    if page.get("epoch") == chain_epoch:
        chained.append(example)
    for entry in page["entries"]:
        at = f"{where}#{entry['seq']}"
        check(list(entry) == ENTRY_FIELDS, f"{at}: entry fields, in order")
        check(entry["type"] in PERIOD_EVENTS | LIFECYCLE_EVENTS, f"{at}: a §3.4 event")
        check((entry["entitlement"] is None) == (entry["accountId"] is None),
              f"{at}: an entitlement exactly when the event names an account")
        check((entry["period"] is not None) == (entry["type"] in PERIOD_EVENTS), f"{at}: a period exactly on period events")
        check(entry["recordedAt"] >= entry["occurredAt"], f"{at}: recorded no earlier than it occurred")
        check(entry["environment"] in ENVIRONMENTS and entry["store"] in STORES, f"{at}: store and environment")
        if entry["entitlement"]:
            check(entry["entitlement"]["accountId"] == entry["accountId"], f"{at}: the named account's entitlement")
            check_entitlement_response(entry["entitlement"], at)
            holding = [environment for environment in ENVIRONMENTS
                       for s in [entry["entitlement"][environment]["governing"]] + entry["entitlement"][environment]["others"]
                       if s and s["subscriptionId"] == entry["subscriptionId"]]
            check(holding in ([], [entry["environment"]]), f"{at}: the subscription sits in its own environment")
        if entry["period"]:
            p = entry["period"]
            check(list(p) == PERIOD_FIELDS and p["start"] < p["end"], f"{at}: period fields, start before end")
            check_money(p["price"], f"{at}.period.price")
            if entry["type"] == "period_refunded":
                check(p["refundedAt"] is not None and p["refundedAt"] >= p["start"], f"{at}: the refund time is set")
            if entry["type"] == "period_refund_reversed":
                check(p["refundedAt"] is None, f"{at}: a reversed refund clears the refund time (INV-7)")
    together = {}
    for entry in page["entries"]:
        together.setdefault((entry["recordedAt"], entry["accountId"]), set()).add(
            json.dumps(entry["entitlement"], sort_keys=True))
    for (recordedAt, _), carried in together.items():
        check(len(carried) == 1, f"{where}: entries recorded together at {recordedAt} carry one entitlement")

# feed.json: the pages of one epoch read as one ledger
for before, after in zip(chained, chained[1:]):
    last = before["body"]["entries"][-1]["seq"] if before["body"]["entries"] else before["request"]["after"]
    check(after["request"]["after"] == last, f"feed/{after['name']} continues where {before['name']} ends")
entries = [entry for example in chained for entry in example["body"]["entries"]]
seqs = [entry["seq"] for entry in entries]
check(seqs[0] == 1 and all(example["body"]["latestSeq"] == seqs[-1] for example in chained),
      "feed: the chained pages hold the whole ledger")
check(any(b - a > 1 for a, b in zip(seqs, seqs[1:])), "feed: seq skips a number (INV-8)")
check(any(a["body"]["entries"] and b["body"]["entries"]
          and a["body"]["entries"][-1]["recordedAt"] == b["body"]["entries"][0]["recordedAt"]
          for a, b in zip(chained, chained[1:])), "feed: a page ends inside one transaction's entries (§5.2)")
restored = feed["ledger_restored"]
check(restored["body"]["epoch"] != chain_epoch and restored["body"]["latestSeq"] < restored["request"]["after"],
      "feed/ledger_restored: a new epoch, latestSeq below the cursor (§6.1)")
types = [entry["type"] for entry in entries]
for event in ["started", "bound", "period_recorded", "renewed", "payment_failed", "updated", "payment_recovered",
              "period_refunded", "period_refund_reversed", "renewal_turned_off", "expired", "revoked", "unbound"]:
    check(event in types, f"feed: carries {event}")
check(any(entry["environment"] == "sandbox" for entry in entries), "feed: carries sandbox entries")
check(any(entry["type"] == "period_refunded"
          and not any(other["type"] == "revoked" and other["recordedAt"] == entry["recordedAt"] for other in entries)
          for entry in entries), "feed: a refund of an earlier period revokes nothing (§3.5)")
trouble = types[types.index("payment_failed"):]
check("updated" in trouble and "payment_recovered" in trouble[trouble.index("updated"):],
      "feed: payment_failed, then updated, then payment_recovered (INV-14)")
recorded = {}
for entry in entries:
    if entry["type"] == "period_recorded":
        recorded.setdefault(entry["period"]["id"], []).append(entry)
check(any(len(es) > 1 and es[0]["accountId"] is None and es[1]["accountId"] is not None for es in recorded.values()),
      "feed: a period recorded unbound is recorded again under the account that claims it (INV-13)")
for periodId, es in recorded.items():
    accounts = [entry["accountId"] for entry in es]
    check(len(accounts) == len(set(accounts)), f"feed: period {periodId} recorded once per account (INV-13)")
lineage = {}
for entry in entries:
    periods = lineage.setdefault(entry["subscriptionId"], [])
    if entry["type"] == "period_recorded" and entry["period"]["id"] not in [p["id"] for p in periods]:
        periods.append(entry["period"])
for subscriptionId, periods in lineage.items():
    for a, b in zip(periods, periods[1:]):
        check(a["end"] <= b["start"], f"feed: the periods of {subscriptionId} never overlap (D-4)")
for i, entry in enumerate(entries):
    if entry["type"] == "renewed":
        new = next(e for e in entries[i:] if e["type"] == "period_recorded")
        last = [e["period"] for e in entries[:i] if e["type"] == "period_recorded"
                and e["subscriptionId"] == entry["subscriptionId"]][-1]
        check(new["period"]["start"] == last["end"], f"feed#{entry['seq']}: a renewal starts where the last period ends (D-4)")
for name, seq in [("active", 3), ("revoked", 15), ("sandbox_active", 13), ("grace", 18), ("on_hold", 19),
                  ("cancelled_access_continues", 24), ("expired", 25), ("never_subscribed", 26)]:
    check(entitlements[name]["body"] == next(e["entitlement"] for e in entries if e["seq"] == seq),
          f"entitlement/{name}: the entitlement the feed carries at seq {seq} (README)")

# the claim doors
public_claim, internal_claim = loaded["app-store-claim.json"], loaded["internal-app-store-claim.json"]
check(list(public_claim["request"]) == ["signedTransaction"], "app-store-claim: AppStoreClaimRequest is {signedTransaction}")
check(sorted(x["status"] for x in public_claim["examples"]) == [200, 200, 400, 409, 503], "app-store-claim: every answer")
for example in public_claim["examples"]:
    where = f"app-store-claim/{example['name']}"
    if example["status"] == 200:
        check_subscription_response(example["body"], where)
    else:
        check(example["body"] == {"code": REFUSALS[example["status"]]}, f"{where}: the {example['status']} code")
check(list(internal_claim["request"]) == ["accountId", "signedTransaction"],
      "internal-app-store-claim: the request is {accountId, signedTransaction}")
check(sorted(x["status"] for x in internal_claim["examples"]) == [200, 200, 400, 409],
      "internal-app-store-claim: every answer")
for example in internal_claim["examples"]:
    where = f"internal-app-store-claim/{example['name']}"
    if example["status"] != 200:
        check(example["body"] == {"code": REFUSALS[example["status"]]}, f"{where}: the {example['status']} code")
        continue
    answer = example["body"]
    check(list(answer) == ["seq", "entitlement"], f"{where}: 200 is {{seq, entitlement}}")
    check_entitlement_response(answer["entitlement"], where)
    check(answer["entitlement"]["accountId"] == internal_claim["request"]["accountId"], f"{where}: the caller's entitlement")
    claimed = next((e for e in entries if e["seq"] == answer["seq"]), None)
    check(claimed is not None and claimed["entitlement"] == answer["entitlement"]
          and not any(e["seq"] > claimed["seq"] and e["recordedAt"] == claimed["recordedAt"] for e in entries),
          f"{where}: seq is the claim's last event, whose entitlement it answers (§5.2)")
check(named("app-store-claim.json")["bound_to_caller"]["body"]["governing"]
      == named("internal-app-store-claim.json")["bound_to_caller"]["body"]["entitlement"]["production"]["governing"],
      "app-store-claim/bound_to_caller answers the copy the internal answer leads to (§5.3)")


# Privacy: ids are UUIDs; no email, signed payload or store transaction id; instants are epoch milliseconds
def walk(value, where):
    if isinstance(value, dict):
        for key, inner in value.items():
            if (key.lower().endswith("id") or key == "epoch") and isinstance(inner, str):
                check(bool(UUID.match(inner)), f"{where}.{key}: a UUID ({inner})")
            walk(inner, f"{where}.{key}")
    elif isinstance(value, list):
        for i, inner in enumerate(value):
            walk(inner, f"{where}[{i}]")
    elif isinstance(value, str):
        check("@" not in value, f"{where}: no email")
        check(not JWS.match(value), f"{where}: no signed payload")
        check(not re.match(r"^\d{12,}$", value), f"{where}: no numeric store id")
    elif isinstance(value, int) and not isinstance(value, bool) and value > 10**12:
        check(value < 10**13, f"{where}: epoch milliseconds")


for name in FILES:
    walk(loaded[name], name)

print(f"{len(passed)} checks passed, {len(failed)} failed")
for claim in failed:
    print("FAIL", claim)
sys.exit(1 if failed else 0)
