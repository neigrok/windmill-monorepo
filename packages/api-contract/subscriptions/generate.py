import json
import pathlib
import sys
from datetime import datetime, timezone
from typing import NamedTuple

HERE = pathlib.Path(__file__).resolve().parent


def ms(text):
    return int(datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp() * 1000)


# What the wire carries (subscriptions.md §3, §5)
SECOND, MINUTE, HOUR, DAY = 1_000, 60_000, 3_600_000, 86_400_000
RENEWAL_SLACK = {"production": DAY, "sandbox": 0}
GRACE = 16 * DAY
PRICE = {"amount": "12.00", "currency": "USD"}
OFFER = {"aiAllowance": {"amount": "7.00", "currency": "USD"}}
MANAGE_URL = {"app_store": "https://apps.apple.com/account/subscriptions"}
ENDED = {"expired", "revoked"}
SIGNED_TRANSACTION = "<the JWS representation StoreKit 2 returns for the verified transaction>"
SUBSCRIPTION_FIELDS = ["subscriptionId", "store", "state", "startedAt", "currentPeriod", "accessUntil", "autoRenew",
                       "nextChargeAt", "nextCharge", "nextProductId", "cancelRequestedAt", "paymentFailedAt",
                       "graceEndsAt", "pauseScheduledFor", "pausedAt", "resumesAt", "offerKind", "offerEndsAt",
                       "endedAt", "endReason"]

# Accounts
BUYER = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"
CLAIMANT = "9387ec65-ab17-4b8c-b145-fd0d622966db"
TESTER = "c806aea4-76c0-4868-acbc-3aa7db2b8dd0"
CHARGED_TWICE = "60eb0e14-f50c-49d6-a496-56ef6c8d4e8e"

# Subscriptions
SUB = "a7d40c52-1e8b-4f3a-9c26-5b0e8c3a1f94"
SUB_UNHINTED = "77f866f6-f995-40d1-b179-345ae244fcc3"
SUB_SANDBOX = "c0498d34-cdf6-466c-963e-68d373253766"
SUB_TESTER_PRODUCTION = "87419ebd-c76e-46ec-a1b1-596f8a3d7c97"
SUB_TESTER_SANDBOX = "4436efdd-bed4-469a-b821-b932c7e62e6b"
SUB_FIRST = "b51b3cd0-b863-46c7-844e-8bc69ecbf266"
SUB_SECOND = "fa87e15b-eab2-450c-8f7f-fe4644c9ab7a"
SUB_PLAY = "c91e2b74-6d3f-4a8e-b015-7f2a9d4c6e38"

# Periods
P1 = "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86"
P2 = "4c7a19e3-b2d0-4f85-9e6a-3d81f5c0a2b7"
P3 = "d9aaabda-5edd-4f39-a5ab-ec4c8e295161"
Q1 = "8f04068f-6d76-4afc-bba4-6d7927bc7c4e"
S1 = "5f28ab82-1d7c-4306-bdf4-c36a55bff2c4"
S2 = "db0e7f48-3c90-456f-813d-5010c088b6d9"

# The ledger before and after a restore
EPOCH = "c09a3ab3-2732-4415-ba88-825ff868cf13"
EPOCH_RESTORED = "2dd74022-4cb9-42f8-8746-0a186269b54e"


# A subscription as the service keeps it; nextChargeAt and nextCharge follow from its state (§3.1)
def subscription(subscriptionId, startedAt, currentPeriod, observedAt, store="app_store", environment="production",
                 state="active", autoRenew=True, **fields):
    start, end = currentPeriod
    charges = state == "active" and autoRenew
    record = dict(subscriptionId=subscriptionId, store=store, environment=environment, plan="windmill_one",
                  state=state, startedAt=startedAt, currentPeriod=(start, end), autoRenew=autoRenew,
                  nextChargeAt=end if charges else None, nextCharge=PRICE if charges else None,
                  nextProductId=None, cancelRequestedAt=None, paymentFailedAt=None, graceEndsAt=None,
                  pauseScheduledFor=None, pausedAt=None, resumesAt=None, offerKind=None, offerEndsAt=None,
                  endedAt=None, endReason=None, observedAt=observedAt)
    record.update(fields)
    return record


def changed(record, **fields):
    kept = {key: value for key, value in record.items() if key not in ("nextChargeAt", "nextCharge")}
    return subscription(**{**kept, **fields})


def access_until(record):
    if record["state"] == "grace":
        return record["graceEndsAt"]
    if record["state"] == "active":
        return record["currentPeriod"][1] + (RENEWAL_SLACK[record["environment"]] if record["autoRenew"] else 0)
    return None


def on_the_wire(record):
    start, end = record["currentPeriod"]
    shown = dict(record, currentPeriod={"start": start, "end": end}, accessUntil=access_until(record))
    return {field: shown[field] for field in SUBSCRIPTION_FIELDS}


# One environment's Entitlement (§5.2)
def fold(records):
    if not records:
        return {"plan": None, "accessUntil": None, "governing": None, "others": []}
    granting = [r for r in records if access_until(r) is not None]
    if granting:
        governing = min(granting, key=lambda r: (-access_until(r), r["subscriptionId"]))
    else:
        governing = min(records, key=lambda r: (-r["observedAt"], r["subscriptionId"]))
    others = sorted((r for r in records if r is not governing and r["state"] not in ENDED),
                    key=lambda r: r["subscriptionId"])
    until = access_until(governing)
    return {"plan": governing["plan"] if until is not None else None, "accessUntil": until,
            "governing": on_the_wire(governing), "others": [on_the_wire(r) for r in others]}


def entitlement(accountId, records):
    return {"accountId": accountId,
            "production": fold([r for r in records if r["environment"] == "production"]),
            "sandbox": fold([r for r in records if r["environment"] == "sandbox"])}


def period(periodId, start, end, refundedAt=None):
    return {"id": periodId, "start": start, "end": end, "price": PRICE, "offerKind": None, "refundedAt": refundedAt}


# GET /v1/subscription as the backend answers it from its copy (§5.3, INV-12)
def subscription_response(account_entitlement, now, allowlisted=False, line_open=True, owner=False):
    grants = lambda shown: shown["accessUntil"] is not None and now < shown["accessUntil"]
    production, sandbox = account_entitlement["production"], account_entitlement["sandbox"]
    environment = "sandbox" if allowlisted and grants(sandbox) and not grants(production) else "production"
    shown = account_entitlement[environment]
    has_windmill_one = owner or grants(production) or (allowlisted and grants(sandbox))
    governing = shown["governing"]
    holds_live = (governing is not None and governing["state"] not in ENDED) or bool(shown["others"])
    purchasable = ["app_store"] if line_open and not has_windmill_one and not holds_live else []
    return {"environment": environment, "allowlisted": allowlisted, **shown,
            "manage": None if governing is None else {"store": governing["store"], "url": MANAGE_URL[governing["store"]]},
            "purchasable": purchasable, "offer": OFFER if purchasable else None}


class Event(NamedTuple):
    type: str
    subscriptionId: str
    occurredAt: int
    period: dict = None
    accountId: str = None


# The service's ledger: each transaction stores subscriptions and bindings, then records its events,
# each carrying its account's entitlement after the transaction (§5.2)
class Ledger:
    def __init__(self, epoch):
        self.epoch, self.seq, self.entries, self.records, self.binding = epoch, 0, [], {}, {}

    def transaction(self, recordedAt, events, records=(), bind=None, unbind=(), skip=0):
        for record in records:
            self.records[record["subscriptionId"]] = record
        self.binding.update(bind or {})
        for subscriptionId in unbind:
            del self.binding[subscriptionId]
        self.seq += skip
        for event in events:
            record = self.records[event.subscriptionId]
            accountId = event.accountId or self.binding.get(event.subscriptionId)
            held = [self.records[s] for s, a in sorted(self.binding.items()) if a == accountId]
            self.seq += 1
            self.entries.append({
                "seq": self.seq, "type": event.type, "occurredAt": event.occurredAt, "recordedAt": recordedAt,
                "subscriptionId": event.subscriptionId, "accountId": accountId, "store": record["store"],
                "environment": record["environment"], "offerKind": record["offerKind"], "period": event.period,
                "entitlement": None if accountId is None else entitlement(accountId, held)})

    def page(self, after, limit):
        return {"epoch": self.epoch, "entries": [e for e in self.entries if e["seq"] > after][:limit],
                "latestSeq": self.seq}

    def at(self, seq):
        return next(e for e in self.entries if e["seq"] == seq)


# The story the feed tells
T0 = ms("2026-12-03T10:00:00")
END1, END2 = ms("2027-01-03T10:00:00"), ms("2027-02-03T10:00:00")
GRACE_ENDS = END2 + GRACE
RECOVERED, END3 = ms("2027-02-22T14:00:00"), ms("2027-03-22T14:00:00")
P2_REFUNDED, P2_REFUND_REVERSED = ms("2027-03-01T11:00:00"), ms("2027-03-09T16:00:00")
TURNED_OFF, ERASED = ms("2027-03-10T20:00:00"), ms("2027-04-01T12:00:00")
UNHINTED, UNHINTED_END = ms("2026-12-05T12:00:00"), ms("2027-01-05T12:00:00")
CLAIMED, Q1_REFUNDED = ms("2026-12-06T09:00:00"), ms("2026-12-20T15:30:00")
SANDBOX, SANDBOX_LATER = ms("2026-12-08T15:00:00"), ms("2027-01-12T15:00:00")

ledger = Ledger(EPOCH)

# The buyer purchases with a hint: one observation starts, binds and records the first period
bought = subscription(SUB, T0, (T0, END1), T0)
ledger.transaction(T0 + 4 * SECOND, records=[bought], bind={SUB: BUYER}, events=[
    Event("started", SUB, T0), Event("bound", SUB, T0), Event("period_recorded", SUB, T0, period(P1, T0, END1))])

# A purchase without a hint is recorded unbound, then claimed: the claim re-records its period
unhinted = subscription(SUB_UNHINTED, UNHINTED, (UNHINTED, UNHINTED_END), UNHINTED)
ledger.transaction(UNHINTED + 3 * SECOND, records=[unhinted], events=[
    Event("started", SUB_UNHINTED, UNHINTED),
    Event("period_recorded", SUB_UNHINTED, UNHINTED, period(Q1, UNHINTED, UNHINTED_END))])
ledger.transaction(CLAIMED, bind={SUB_UNHINTED: CLAIMANT}, events=[
    Event("bound", SUB_UNHINTED, CLAIMED),
    Event("period_recorded", SUB_UNHINTED, CLAIMED, period(Q1, UNHINTED, UNHINTED_END))])
CLAIM_SEQ = ledger.seq

# A tester buys in sandbox, where a month is five minutes; one seq is skipped before it
sandbox = subscription(SUB_SANDBOX, SANDBOX, (SANDBOX, SANDBOX + 5 * MINUTE), SANDBOX, environment="sandbox")
ledger.transaction(SANDBOX + 2 * SECOND, records=[sandbox], bind={SUB_SANDBOX: TESTER}, skip=1, events=[
    Event("started", SUB_SANDBOX, SANDBOX), Event("bound", SUB_SANDBOX, SANDBOX),
    Event("period_recorded", SUB_SANDBOX, SANDBOX, period(S1, SANDBOX, SANDBOX + 5 * MINUTE))])
sandbox_renewed = changed(sandbox, currentPeriod=(SANDBOX + 5 * MINUTE, SANDBOX + 10 * MINUTE),
                          observedAt=SANDBOX + 5 * MINUTE)
ledger.transaction(SANDBOX + 5 * MINUTE + 2 * SECOND, records=[sandbox_renewed], events=[
    Event("renewed", SUB_SANDBOX, SANDBOX + 5 * MINUTE),
    Event("period_recorded", SUB_SANDBOX, SANDBOX + 5 * MINUTE,
          period(S2, SANDBOX + 5 * MINUTE, SANDBOX + 10 * MINUTE))])

# The claimant's period in force is refunded: the period fact and the revocation
unhinted_revoked = changed(unhinted, state="revoked", autoRenew=False, endedAt=Q1_REFUNDED, endReason="refunded",
                           observedAt=Q1_REFUNDED)
ledger.transaction(Q1_REFUNDED + 2 * SECOND, records=[unhinted_revoked], events=[
    Event("period_refunded", SUB_UNHINTED, Q1_REFUNDED, period(Q1, UNHINTED, UNHINTED_END, Q1_REFUNDED)),
    Event("revoked", SUB_UNHINTED, Q1_REFUNDED)])

# The buyer renews: charged an hour early, the period starts where the last one ends (D-4)
renewed = changed(bought, currentPeriod=(END1, END2), observedAt=END1 - HOUR)
ledger.transaction(END1 - HOUR + 10 * SECOND, records=[renewed], events=[
    Event("renewed", SUB, END1 - HOUR), Event("period_recorded", SUB, END1 - HOUR, period(P2, END1, END2))])

# The next charge fails: grace, then on hold once grace ends (updated, INV-14), then recovered
grace = changed(renewed, state="grace", paymentFailedAt=END2, graceEndsAt=GRACE_ENDS, observedAt=END2)
ledger.transaction(END2 + 3 * SECOND, records=[grace], events=[Event("payment_failed", SUB, END2)])
on_hold = changed(grace, state="on_hold", graceEndsAt=None, observedAt=GRACE_ENDS)
ledger.transaction(GRACE_ENDS + 3 * SECOND, records=[on_hold], events=[Event("updated", SUB, GRACE_ENDS)])
recovered = changed(on_hold, state="active", currentPeriod=(RECOVERED, END3), paymentFailedAt=None,
                    observedAt=RECOVERED)
ledger.transaction(RECOVERED + 3 * SECOND, records=[recovered], events=[
    Event("payment_recovered", SUB, RECOVERED), Event("period_recorded", SUB, RECOVERED, period(P3, RECOVERED, END3))])

# An earlier period is refunded and the refund reversed; the subscription stays active (§3.5)
ledger.transaction(P2_REFUNDED + 2 * SECOND, records=[changed(recovered, observedAt=P2_REFUNDED)], events=[
    Event("period_refunded", SUB, P2_REFUNDED, period(P2, END1, END2, P2_REFUNDED))])
ledger.transaction(P2_REFUND_REVERSED + 2 * SECOND, records=[changed(recovered, observedAt=P2_REFUND_REVERSED)],
                   events=[Event("period_refund_reversed", SUB, P2_REFUND_REVERSED, period(P2, END1, END2))])

# The buyer turns renewal off, the subscription expires, and the closed account is finally erased
turned_off = changed(recovered, autoRenew=False, cancelRequestedAt=TURNED_OFF, observedAt=TURNED_OFF)
ledger.transaction(TURNED_OFF + 2 * SECOND, records=[turned_off], events=[Event("renewal_turned_off", SUB, TURNED_OFF)])
expired = changed(turned_off, state="expired", endedAt=END3, endReason="cancelled", observedAt=END3)
ledger.transaction(END3 + 4 * SECOND, records=[expired], events=[Event("expired", SUB, END3)])
ledger.transaction(ERASED, unbind=[SUB], events=[Event("unbound", SUB, ERASED, accountId=BUYER)])

# Accounts no feed page reaches
tester_production = subscription(SUB_TESTER_PRODUCTION, ms("2026-12-04T09:00:00"),
                                 (ms("2026-12-04T09:00:00"), ms("2027-01-04T09:00:00")), ms("2027-01-04T09:00:00"),
                                 state="expired", autoRenew=False, cancelRequestedAt=ms("2026-12-11T17:00:00"),
                                 endedAt=ms("2027-01-04T09:00:00"), endReason="cancelled")
tester_sandbox = subscription(SUB_TESTER_SANDBOX, SANDBOX_LATER, (SANDBOX_LATER, SANDBOX_LATER + 5 * MINUTE),
                              SANDBOX_LATER, environment="sandbox")
first = subscription(SUB_FIRST, T0, (T0, END1), T0)
second = subscription(SUB_SECOND, ms("2026-12-10T08:00:00"), (ms("2026-12-10T08:00:00"), ms("2027-01-10T08:00:00")),
                      ms("2026-12-10T08:00:00"))
play = changed(second, subscriptionId=SUB_PLAY, store="play_store")

# The files
entitlements = {
    "active": ledger.at(3)["entitlement"],
    "cancelled_access_continues": ledger.at(24)["entitlement"],
    "grace": ledger.at(18)["entitlement"],
    "on_hold": ledger.at(19)["entitlement"],
    "expired": ledger.at(25)["entitlement"],
    "revoked": ledger.at(15)["entitlement"],
    "never_subscribed": ledger.at(26)["entitlement"],
    "sandbox_active": ledger.at(13)["entitlement"],
    "sandbox_active_production_expired": entitlement(TESTER, [tester_production, tester_sandbox]),
    "charged_twice": entitlement(CHARGED_TWICE, [first, second]),
    "charged_by_two_stores": entitlement(CHARGED_TWICE, [first, play]),
}

responses = [
    ("active", subscription_response(entitlements["active"], T0 + DAY)),
    ("cancelled_access_continues", subscription_response(entitlements["cancelled_access_continues"], TURNED_OFF + DAY)),
    ("grace", subscription_response(entitlements["grace"], END2 + 2 * DAY)),
    ("on_hold", subscription_response(entitlements["on_hold"], GRACE_ENDS + DAY)),
    ("expired_line_open", subscription_response(entitlements["expired"], END3 + DAY)),
    ("revoked_line_open", subscription_response(entitlements["revoked"], Q1_REFUNDED + DAY)),
    ("never_subscribed_line_open", subscription_response(entitlements["never_subscribed"], ERASED + DAY)),
    ("allowlisted_never_subscribed_line_open",
     subscription_response(entitlements["never_subscribed"], ERASED + DAY, allowlisted=True)),
    ("never_subscribed_line_closed",
     subscription_response(entitlements["never_subscribed"], ERASED + DAY, line_open=False)),
    ("charged_twice", subscription_response(entitlements["charged_twice"], ms("2026-12-12T10:00:00"))),
    ("sandbox_allowlisted", subscription_response(entitlements["sandbox_active_production_expired"],
                                                  SANDBOX_LATER + 2 * MINUTE, allowlisted=True)),
    ("sandbox_not_allowlisted_line_open", subscription_response(entitlements["sandbox_active_production_expired"],
                                                                SANDBOX_LATER + 2 * MINUTE)),
]

pages = [("from_zero", 0, 6), ("claimed_then_sandbox", 6, 6), ("refunded_then_renewed", 13, 4),
         ("payment_trouble", 17, 4), ("older_period_refunded", 21, 4), ("account_erased", 25, 500),
         ("caught_up", 26, 500)]

claimed = ledger.at(CLAIM_SEQ)
claim_answer = subscription_response(claimed["entitlement"], CLAIMED + MINUTE)
internal_answer = {"seq": claimed["seq"], "entitlement": claimed["entitlement"]}
refused = lambda status, code: {"status": status, "body": {"code": code}}

FILES = {
    "entitlement.json": {"examples": [{"name": name, "body": body} for name, body in entitlements.items()]},
    "subscription.json": {"examples": [{"name": name, "body": body} for name, body in responses]},
    "feed.json": {"examples": [
        {"name": name, "request": {"after": after, "limit": limit}, "body": ledger.page(after, limit)}
        for name, after, limit in pages] + [
        {"name": "ledger_restored", "request": {"after": 26, "limit": 500},
         "body": {"epoch": EPOCH_RESTORED, "entries": [], "latestSeq": 21}}]},
    "app-store-claim.json": {"request": {"signedTransaction": SIGNED_TRANSACTION}, "examples": [
        {"name": "bound_to_caller", "status": 200, "body": claim_answer},
        {"name": "already_bound_to_caller", "status": 200, "body": claim_answer},
        {"name": "bound_to_another_account", **refused(409, "bound_to_another_account")},
        {"name": "transaction_not_verified", **refused(400, "invalid_transaction")},
        {"name": "service_unavailable", **refused(503, "subscriptions_unavailable")}]},
    "internal-app-store-claim.json": {"request": {"accountId": CLAIMANT, "signedTransaction": SIGNED_TRANSACTION},
                                      "examples": [
        {"name": "bound_to_caller", "status": 200, "body": internal_answer},
        {"name": "already_bound_to_caller", "status": 200, "body": internal_answer},
        {"name": "bound_to_another_account", **refused(409, "bound_to_another_account")},
        {"name": "transaction_not_verified", **refused(400, "invalid_transaction")}]},
}

if __name__ == "__main__":
    rendered = {name: json.dumps(body, indent=2, ensure_ascii=False) + "\n" for name, body in FILES.items()}
    if sys.argv[1:] == ["--check"]:
        stale = [name for name, text in rendered.items()
                 if not (HERE / name).exists() or (HERE / name).read_text() != text]
        for name in stale:
            print(f"FAIL {name} is not what generate.py writes; run python3 generate.py")
        if not stale:
            print(f"the {len(rendered)} fixtures are what generate.py writes")
        sys.exit(1 if stale else 0)
    for name, text in rendered.items():
        (HERE / name).write_text(text)
    print(f"wrote {len(rendered)} fixtures from a ledger of {ledger.seq} events")
