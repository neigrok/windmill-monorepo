#include "platform/subscriptions/PeriodFunding.h"

#include "platform/adapters/postgres/PgAiBudgetRepository.h"
#include "platform/application/WriteObservation.h"
#include "platform/subscriptions/FeedFollower.h"
#include "platform/subscriptions/PgEntitlementCopy.h"
#include "test/PgTestPool.h"
#include "test/platform/subscriptions/FeedFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// Opt-in integration cases: a live Postgres built by db/schema.sql and WM_PG_TEST set (RUNNING.md §7); otherwise each
// reports skip. The follower reads the golden pages of packages/api-contract/subscriptions/feed.json, or pages made of
// their entries, into the copy and the AI ledger.
using namespace wm;
using namespace wm::subscriptions;
using namespace wm::subscriptions::test;

namespace {
// An empty copy that never read the feed and an empty AI ledger, beside the three accounts the fixture ledger names.
void freshLedger() {
  PgLease lease{*pgTestPool()};
  pqxx::work txn{*lease};
  txn.exec("DELETE FROM account_entitlements");
  txn.exec("UPDATE subscription_feed_cursor SET epoch = NULL, seq = 0");
  txn.exec("DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
           "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
  txn.exec("INSERT INTO users (id, email) VALUES "
           "('3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61', 'fund-3f6c2a1e@example.com'), "
           "('9387ec65-ab17-4b8c-b145-fd0d622966db', 'fund-9387ec65@example.com'), "
           "('c806aea4-76c0-4868-acbc-3aa7db2b8dd0', 'fund-c806aea4@example.com') ON CONFLICT (id) DO NOTHING");
  txn.commit();
}

// Every grant, as its period id, account, stretch, amount, close and the statement it was brought to.
std::string grantsAsText() {
  PgLease lease{*pgTestPool()};
  pqxx::read_transaction txn{*lease};
  const pqxx::result rows = txn.exec(
      "SELECT id, account_id, period_start_ms, period_end_ms, amount_nanos, coalesce(closed_at_ms::text, '-'), "
      "coalesce(left(statement_epoch, 8) || '/' || statement_seq, '-') FROM ai_budget_grants "
      "ORDER BY period_start_ms, id");
  std::string text;
  for (std::size_t index = 0; index < rows.size(); ++index) {
    const auto row = rows[index];
    text += row[0].as<std::string>() + " account=" + row[1].as<std::string>().substr(0, 8) + " " +
            row[2].as<std::string>() + "-" + row[3].as<std::string>() + " amount=" + row[4].as<std::string>() +
            " closed=" + row[5].as<std::string>() + " statement=" + row[6].as<std::string>() + "\n";
  }
  return text;
}

std::string cursorAsText() {
  PgLease lease{*pgTestPool()};
  pqxx::read_transaction txn{*lease};
  const pqxx::result cursor = txn.exec("SELECT coalesce(epoch, '-'), seq FROM subscription_feed_cursor");
  return cursor[0][0].as<std::string>().substr(0, 8) + "/" + cursor[0][1].as<std::string>();
}

// The entry the fixture ledger recorded at `seq`.
Json::Value ledgerEntry(Seq seq) {
  for (const char* name : {"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble",
                           "older_period_refunded", "account_erased"}) {
    const Json::Value page = contractExample("feed.json", name)["body"];
    for (const Json::Value& entry : page["entries"])
      if (entry["seq"].asUInt64() == seq) return entry;
  }
  throw std::runtime_error("the fixture ledger records nothing at that seq");
}

// That entry renumbered as `seq`, of `type`, for the period `periodId` over [start, end) refunded at `refundedAt`.
Json::Value entryOf(Seq from, Seq seq, const char* type, const char* periodId, long long start, long long end,
                    Json::Value refundedAt = Json::Value()) {
  Json::Value entry = ledgerEntry(from);
  entry["seq"] = Json::UInt64(seq);
  entry["type"] = type;
  entry["period"]["id"] = periodId;
  entry["period"]["start"] = Json::Int64(start);
  entry["period"]["end"] = Json::Int64(end);
  entry["period"]["refundedAt"] = std::move(refundedAt);
  return entry;
}

// A page of the fixture ledger's epoch holding `entries`, the newest event the ledger holds being its last.
Json::Value pageOf(const std::vector<Json::Value>& entries) {
  Json::Value body = contractExample("feed.json", "caught_up")["body"];
  for (const Json::Value& entry : entries) body["entries"].append(entry);
  body["latestSeq"] = entries.back()["seq"];
  return body;
}

std::string nameOf(FollowStep step) {
  switch (step) {
    case FollowStep::applied: return "applied";
    case FollowStep::caughtUp: return "caughtUp";
    case FollowStep::behind: return "behind";
    case FollowStep::rebuilt: return "rebuilt";
    case FollowStep::unavailable: return "unavailable";
    case FollowStep::failed: return "failed";
    case FollowStep::overtaken: return "overtaken";
  }
  return "?";
}

// Every failure and warning reported while it lives: what reaches Sentry.
struct Reports : FailureReporter {
  std::vector<std::string> failures;
  std::vector<std::string> warnings;
  std::vector<std::string> warningRequestIds;

  Reports() { installWriteReporter(std::shared_ptr<FailureReporter>(this, [](FailureReporter*) {})); }
  ~Reports() override { installWriteReporter(nullptr); }

  void report(const std::string&, const std::string& where, const std::string&) override { failures.push_back(where); }
  void reportWrite(const std::string& operation, const std::string&, const std::string&, const std::string& outcome,
                   const std::string&, const std::string&) override {
    failures.push_back(operation + " " + outcome);
  }
  void reportWarning(const std::string& operation, const std::string&, const std::string& door,
                     const std::string& outcome, const std::string& requestId,
                     const std::map<std::string, std::string>& tags) override {
    std::string warning = operation + " " + door + " " + outcome;
    for (const auto& [name, value] : tags) warning += " " + name + "=" + value;
    warnings.push_back(warning);
    warningRequestIds.push_back(requestId);
  }
};

// Every completion line of the follower and of the ledger calls its funding makes, as operation outcome/level.
class LedgerLines {
public:
  LedgerLines() {
    installWriteSink([this](const WriteCompletion& line) {
      if (line.operation != "subscription.fund" && line.operation != "subscription.refund" &&
          line.operation != "subscription.follow")
        return;
      const char* level = line.severity == WriteSeverity::error  ? "error"
                          : line.severity == WriteSeverity::warn ? "warn"
                          : line.severity == WriteSeverity::info ? "info"
                                                                 : "debug";
      std::lock_guard lock{mutex_};
      lines_.push_back(line.operation + " " + line.outcome + "/" + level + " " + line.door);
      requestIds_[line.operation + " " + line.outcome].push_back(line.requestId);
    });
  }
  ~LedgerLines() { installWriteSink({}); }

  std::vector<std::string> taken() {
    std::lock_guard lock{mutex_};
    return std::exchange(lines_, {});
  }

  std::vector<std::string> requestIdsOf(const std::string& line) {
    std::lock_guard lock{mutex_};
    return requestIds_[line];
  }

private:
  std::mutex mutex_;
  std::vector<std::string> lines_;
  std::map<std::string, std::vector<std::string>> requestIds_;
};

// The follower, the copy and the AI ledger as main.cpp wires them, over the test database; `after` runs beside the
// funding once it has, and `periodNanos` is what a paid period funds.
struct Ledger {
  explicit Ledger(SubscriptionFeed& feed, FurtherConsumers after = {}, long long periodNanos = AiBudgetLimits{}.paidPeriodNanos)
      : copy{pgTestPool()}, repository{pgTestPool()},
        budgets{repository, [periodNanos] {
                  AiBudgetLimits limits;
                  limits.paidPeriodNanos = periodNanos;
                  return limits;
                }, [this] { return now; }},
        funding{budgets, periodNanos}, follower{feed, copy, withFunding(std::move(after)), reports} {}

  FurtherConsumers withFunding(FurtherConsumers after) {
    after.beside.insert(after.beside.begin(), funding);
    return after;
  }

  long long now = 0;
  Reports reports;
  PgEntitlementCopy copy;
  PgAiBudgetRepository repository;
  AiBudgetService budgets;
  PeriodFunding funding;
  FeedFollower follower;
};

// A consumer beside the funding that fails once at the first page it is handed whose epoch is `epoch`: whatever
// fails after the funding committed, before the page does.
struct FailsOnceAfterFunding : FeedPageSideConsumer {
  explicit FailsOnceAfterFunding(std::string epoch) : epoch(std::move(epoch)) {}
  std::string epoch;
  bool failed = false;
  void consume(const PageTxn& page, const std::vector<FeedEntry>&) override {
    if (page.target().epoch.starts_with(epoch) && !std::exchange(failed, true))
      throw std::runtime_error("PRIVATE_PAGE_DETAIL");
  }
};

constexpr const char* kSpanned =
    "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86 account=3f6c2a1e 1796292000000-1798970400000 amount=7000000000 closed=- "
    "statement=EPOCH/3\n"
    "8f04068f-6d76-4afc-bba4-6d7927bc7c4e account=9387ec65 1796472000000-1799150400000 amount=7000000000 "
    "closed=1797780600000 statement=EPOCH/14\n"
    "4c7a19e3-b2d0-4f85-9e6a-3d81f5c0a2b7 account=3f6c2a1e 1798970400000-1801648800000 amount=7000000000 closed=- "
    "statement=EPOCH/23\n"
    "d9aaabda-5edd-4f39-a5ab-ec4c8e295161 account=3f6c2a1e 1803304800000-1805724000000 amount=7000000000 closed=- "
    "statement=EPOCH/21\n";

// `text` with every EPOCH read as `epoch`.
std::string underEpoch(std::string text, const std::string& epoch) {
  for (std::size_t at = text.find("EPOCH"); at != std::string::npos; at = text.find("EPOCH")) text.replace(at, 5, epoch);
  return text;
}

constexpr const char* kAccount = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61";
constexpr long long kStart = 1796292000000;
constexpr long long kEnd = 1798970400000;
constexpr long long kDay = 86'400'000;
constexpr const char* kBought = "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86";
constexpr const char* kSecond = "6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

// The fixture ledger's `period_recorded` at seq 3 for `periodId` over [start, end), renumbered as `seq`, on a page alone.
Json::Value recordedAlone(Seq seq, const char* periodId, long long start, long long end) {
  return pageOf({entryOf(3, seq, "period_recorded", periodId, start, end)});
}
}

TEST(pg_subscription_fund_the_chained_pages_fund_exactly_the_paid_production_periods_once) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble", "older_period_refunded",
              "account_erased", "caught_up"});
  Ledger ledger{feed};
  LedgerLines lines;

  // Seq 5 is recorded before its subscription names an account, 11 and 13 are sandbox, 18 and 19 are grace and on
  // hold: none funds. Seq 14 closes 8f04068f at its refund. 22 refunds 4c7a19e3 after its end and 23, on the same page,
  // reverses that: only the reversal acts, and the grant it leaves open is brought to it.
  while (ledger.follower.follow() == FollowStep::applied) {}
  CHECK_EQ(grantsAsText(), underEpoch(kSpanned, "c09a3ab3"));
  CHECK_EQ(cursorAsText(), std::string("c09a3ab3/26"));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{
      "subscription.fund ok/info background", "subscription.follow ok/info background",
      "subscription.fund ok/info background", "subscription.follow ok/info background",
      "subscription.refund ok/info background", "subscription.fund ok/info background",
      "subscription.follow ok/info background",
      "subscription.fund ok/info background", "subscription.follow ok/info background",
      "subscription.refund ok/info background", "subscription.follow ok/info background",
      "subscription.follow ok/info background"}));

  // The same ledger restored whole under a new epoch is read again as one page: each period's last statement brings its
  // grant to the new epoch, funding nothing twice and never passing through 4c7a19e3's refund.
  for (const char* name : {"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble",
                           "older_period_refunded", "account_erased", "caught_up"})
    feed.serve(contractExample("feed.json", name)["request"]["after"].asUInt64(), restored(name, 26));
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("rebuilt"));
  CHECK_EQ(grantsAsText(), underEpoch(kSpanned, "2dd74022"));
  CHECK_EQ(cursorAsText(), std::string("2dd74022/26"));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{
      "subscription.fund replay/warn background", "subscription.refund ok/info background",
      "subscription.fund replay/warn background", "subscription.refund ok/info background",
      "subscription.follow rebuilt/warn background"}));

  // Then restored from a backup taken at seq 21 under that same epoch: 4c7a19e3's last statement there is its recording,
  // older than the reversal its grant holds, and nothing goes back to it.
  feed.serve({"ledger_restored"});
  feed.serve(0, restored("from_zero", 21));
  feed.serve(6, restored("claimed_then_sandbox", 21));
  feed.serve(13, restored("refunded_then_renewed", 21));
  feed.serve(17, restored("payment_trouble", 21));
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("rebuilt"));
  CHECK_EQ(grantsAsText(), underEpoch(kSpanned, "2dd74022"));
  CHECK_EQ(cursorAsText(), std::string("2dd74022/21"));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{
      "subscription.fund replay/warn background", "subscription.refund replay/warn background",
      "subscription.fund replay/warn background", "subscription.fund replay/warn background",
      "subscription.follow rebuilt/warn background"}));
  CHECK(ledger.reports.warnings.empty());
  CHECK_EQ(ledger.reports.failures, (std::vector<std::string>{"subscription.follow.restored"}));
}

TEST(pg_subscription_fund_a_page_read_again_after_it_rolled_back_funds_nothing_twice) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox"});
  FailsOnceAfterFunding failsOnce{"c09a3ab3"};
  Ledger ledger{feed, FurtherConsumers{.beside = {failsOnce}}};
  LedgerLines lines;

  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("failed"));
  CHECK_EQ(cursorAsText(), std::string("-/0"));
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(grantsAsText(), std::string(
      "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86 account=3f6c2a1e 1796292000000-1798970400000 amount=7000000000 closed=- "
      "statement=c09a3ab3/3\n"
      "8f04068f-6d76-4afc-bba4-6d7927bc7c4e account=9387ec65 1796472000000-1799150400000 amount=7000000000 closed=- "
      "statement=c09a3ab3/7\n"));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{
      "subscription.fund ok/info background", "subscription.follow failed/error background",
      "subscription.fund replay/warn background", "subscription.follow ok/info background",
      "subscription.fund ok/info background", "subscription.follow ok/info background"}));
  CHECK_EQ(ledger.reports.failures, (std::vector<std::string>{"subscription.follow failed"}));
}

TEST(pg_subscription_fund_a_refund_closes_the_grant_without_giving_back_its_spend_and_a_reversal_reopens_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  const long long refundedAt = kStart + 10 * kDay;
  FakeFeed feed;
  feed.serve(0, pageOf({ledgerEntry(3)}));
  feed.serve(3, pageOf({entryOf(3, 4, "period_refunded", kBought, kStart, kEnd, Json::Int64(refundedAt))}));
  feed.serve(4, pageOf({entryOf(3, 5, "period_refund_reversed", kBought, kStart, kEnd)}));
  // A period first heard of refunded funds nothing until the refund is reversed.
  feed.serve(5, pageOf({entryOf(3, 6, "period_recorded", kSecond, kEnd, kEnd + 31 * kDay, Json::Int64(kEnd + kDay))}));
  feed.serve(6, pageOf({entryOf(3, 7, "period_refund_reversed", kSecond, kEnd, kEnd + 31 * kDay)}));
  Ledger ledger{feed};
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, kAccount}, AiBudgetTier::WindmillOne};

  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  ledger.now = kStart + kDay;
  const auto paid = ledger.budgets.reserve("spent-before-the-refund", principal, 3'000'000'000);
  REQUIRE(paid.reservation);
  CHECK_EQ(paid.reservation->grantId, std::optional<std::string>{kBought});
  CHECK_EQ(ledger.budgets.markDispatched("spent-before-the-refund").code, AiBudgetCode::Ok);
  CHECK_EQ(ledger.budgets.settle("spent-before-the-refund", 3'000'000'000).code, AiBudgetCode::Ok);

  // Closed at its refund: from then the account is on the free signed-in allowance, and the $3 spent stays spent.
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(grantsAsText(), "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86 account=3f6c2a1e 1796292000000-1798970400000 "
                           "amount=7000000000 closed=" + std::to_string(refundedAt) + " statement=c09a3ab3/4\n");
  ledger.now = refundedAt;
  const AiBudgetView free = ledger.budgets.view(principal);
  CHECK_EQ(free.tier, AiBudgetTier::LoggedIn);
  CHECK_EQ(free.window, AiBudgetWindow::CalendarMonth);
  CHECK_EQ(free.limitNanos, std::optional<long long>{AiBudgetLimits{}.loggedInMonthlyNanos});
  CHECK_EQ(free.code, AiBudgetCode::Ok);
  CHECK_EQ(ledger.repository.snapshot(principal, kStart + kDay, AiBudgetLimits{}).subject.spentNanos, 3'000'000'000);
  CHECK_EQ(ledger.budgets.reserve("talk-after-the-refund", principal, 1, std::nullopt, AiBudgetFunding::GrantOnly).code,
           AiBudgetCode::FundingRequired);

  // Reopened by the reversal, with what was spent on it before.
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  const AiBudgetView reopened = ledger.budgets.view(principal);
  CHECK_EQ(reopened.tier, AiBudgetTier::WindmillOne);
  CHECK_EQ(reopened.window, AiBudgetWindow::BillingPeriod);
  CHECK_EQ(reopened.usedNanos, 3'000'000'000);
  CHECK_EQ(reopened.remainingNanos, 4'000'000'000);
  CHECK_EQ(reopened.resetsAtMs, std::optional<long long>{kEnd});

  LedgerLines lines;
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(grantsAsText(), std::string(
      "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86 account=3f6c2a1e 1796292000000-1798970400000 amount=7000000000 closed=- "
      "statement=c09a3ab3/5\n"
      "6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d account=3f6c2a1e 1798970400000-1801648800000 amount=7000000000 closed=- "
      "statement=c09a3ab3/7\n"));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{
      "subscription.follow ok/info background", "subscription.refund unchanged/info background",
      "subscription.fund ok/info background", "subscription.follow ok/info background"}));
}

TEST(pg_subscription_fund_an_overlapping_or_another_accounts_period_is_a_logged_conflict_and_the_page_commits) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  const char* later = "1c2d3e4f-5061-4b72-8c83-d4e5f6071829";
  Json::Value elsewhere = ledgerEntry(7);
  elsewhere["seq"] = Json::UInt64(4);
  elsewhere["period"]["id"] = kBought;
  FakeFeed feed;
  // A second subscription of the account charged over the same stretch, and the first period claimed by another account.
  feed.serve(0, pageOf({ledgerEntry(1), entryOf(3, 2, "period_recorded", kBought, kStart, kEnd),
                        entryOf(3, 3, "period_recorded", kSecond, kStart, kEnd)}));
  feed.serve(3, pageOf({elsewhere}));
  // The first is refunded early, a later period of the second fits after the close, and the reversal would overlap it.
  feed.serve(4, pageOf({entryOf(3, 5, "period_refunded", kBought, kStart, kEnd, Json::Int64(kStart + kDay))}));
  feed.serve(5, recordedAlone(6, later, kStart + 2 * kDay, kEnd));
  feed.serve(6, pageOf({entryOf(3, 7, "period_refund_reversed", kBought, kStart, kEnd)}));
  Ledger ledger{feed};
  LedgerLines lines;

  for (int page = 0; page < 5; ++page) CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(cursorAsText(), std::string("c09a3ab3/7"));
  CHECK_EQ(grantsAsText(), "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86 account=3f6c2a1e 1796292000000-1798970400000 "
                           "amount=7000000000 closed=" + std::to_string(kStart + kDay) + " statement=c09a3ab3/5\n" +
                           "1c2d3e4f-5061-4b72-8c83-d4e5f6071829 account=3f6c2a1e " +
                           std::to_string(kStart + 2 * kDay) + "-1798970400000 amount=7000000000 closed=- "
                           "statement=c09a3ab3/6\n");
  CHECK_EQ(lines.taken(), (std::vector<std::string>{
      "subscription.fund ok/info background", "subscription.fund conflict/warn background",
      "subscription.follow ok/info background",
      "subscription.fund conflict/warn background", "subscription.follow ok/info background",
      "subscription.refund ok/info background", "subscription.follow ok/info background",
      "subscription.fund ok/info background", "subscription.follow ok/info background",
      "subscription.refund conflict/warn background", "subscription.follow ok/info background"}));
  CHECK_EQ(ledger.reports.warnings, (std::vector<std::string>{
      "subscription.fund background conflict event=period_recorded",
      "subscription.fund background conflict event=period_recorded",
      "subscription.refund background conflict event=period_refund_reversed"}));
  // Each warning goes under the request of its own call's line, never under a page's, so it takes no failure's Issue.
  const auto fundConflicts = lines.requestIdsOf("subscription.fund conflict");
  const auto refundConflicts = lines.requestIdsOf("subscription.refund conflict");
  CHECK_EQ(ledger.reports.warningRequestIds,
           (std::vector<std::string>{fundConflicts.at(0), fundConflicts.at(1), refundConflicts.at(0)}));
  for (const std::string& page : lines.requestIdsOf("subscription.follow ok"))
    for (const std::string& warning : ledger.reports.warningRequestIds) CHECK(page != warning);
  CHECK(ledger.reports.failures.empty());
}

TEST(pg_subscription_fund_a_period_of_a_refunded_grants_stretch_funds_and_the_follower_moves_on) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  const long long beforeItBegan = kStart - 3'600'000;
  FakeFeed feed;
  feed.serve(0, recordedAlone(1, kBought, kStart, kEnd));
  feed.serve(1, pageOf({entryOf(3, 2, "period_refunded", kBought, kStart, kEnd, Json::Int64(beforeItBegan))}));
  feed.serve(2, recordedAlone(3, kSecond, kStart, kEnd));
  Ledger ledger{feed};

  for (int page = 0; page < 3; ++page) CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(cursorAsText(), std::string("c09a3ab3/3"));
  CHECK_EQ(grantsAsText(), "6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d account=3f6c2a1e 1796292000000-1798970400000 "
                           "amount=7000000000 closed=- statement=c09a3ab3/3\n"
                           "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86 account=3f6c2a1e 1796292000000-1798970400000 "
                           "amount=7000000000 closed=" + std::to_string(beforeItBegan) + " statement=c09a3ab3/2\n");
  CHECK(ledger.reports.failures.empty());
  CHECK(ledger.reports.warnings.empty());
}

TEST(pg_subscription_fund_a_renewal_dated_before_its_period_began_funds_from_the_end_of_the_one_it_renews) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  const long long charged = kEnd - 3'600'000;
  FakeFeed feed;
  feed.serve(0, recordedAlone(1, kBought, kStart, kEnd));
  feed.serve(1, recordedAlone(2, kSecond, charged, kEnd + 31 * kDay));
  Ledger ledger{feed};
  LedgerLines lines;

  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(grantsAsText(), "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86 account=3f6c2a1e 1796292000000-1798970400000 "
                           "amount=7000000000 closed=- statement=c09a3ab3/1\n"
                           "6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d account=3f6c2a1e 1798970400000-" +
                           std::to_string(kEnd + 31 * kDay) + " amount=7000000000 closed=- statement=c09a3ab3/2\n");
  CHECK_EQ(lines.taken(), (std::vector<std::string>{
      "subscription.fund ok/info background", "subscription.follow ok/info background",
      "subscription.fund ok/info background", "subscription.follow ok/info background"}));
}

TEST(pg_subscription_fund_a_rebuild_that_stops_partway_leaves_every_grant_at_its_periods_last_statement) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  const char* renewal = "1c2d3e4f-5061-4b72-8c83-d4e5f6071829";
  const long long renewalEnd = kEnd + 31 * kDay;
  // The bought period refunded and the refund reversed; its renewal refunded, reversed and refunded again: one entry a
  // page, as they happened.
  const std::vector<Json::Value> history{
      entryOf(3, 1, "period_recorded", kBought, kStart, kEnd),
      entryOf(3, 2, "period_refunded", kBought, kStart, kEnd, Json::Int64(kStart + 5 * kDay)),
      entryOf(3, 3, "period_refund_reversed", kBought, kStart, kEnd),
      entryOf(3, 4, "period_recorded", renewal, kEnd, renewalEnd),
      entryOf(3, 5, "period_refunded", renewal, kEnd, renewalEnd, Json::Int64(kEnd + 5 * kDay)),
      entryOf(3, 6, "period_refund_reversed", renewal, kEnd, renewalEnd),
      entryOf(3, 7, "period_refunded", renewal, kEnd, renewalEnd, Json::Int64(kEnd + 10 * kDay))};
  FakeFeed feed;
  for (Seq seq = 1; seq <= 7; ++seq) feed.serve(seq - 1, pageOf({history[seq - 1]}));
  FailsOnceAfterFunding failsInTheRebuild{"2dd74022"};
  // A consumer of the page that fails on the restored ledger's first read: a rebuild stopped before funding sees it.
  struct FailsInPageOnce : FeedEntryConsumer {
    bool failed = false;
    void consume(PageTxn& page, const FeedEntry& entry) override {
      if (page.rebuilding() && entry.seq == 2 && !std::exchange(failed, true)) throw std::runtime_error("PRIVATE_DETAIL");
    }
  } failsInPage;
  Ledger ledger{feed, FurtherConsumers{.inPage = {failsInPage}, .beside = {failsInTheRebuild}}};
  for (int page = 0; page < 7; ++page) CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  const std::string reversedAndRefunded =
      "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86 account=3f6c2a1e 1796292000000-1798970400000 amount=7000000000 closed=- "
      "statement=EPOCH/3\n"
      "1c2d3e4f-5061-4b72-8c83-d4e5f6071829 account=3f6c2a1e 1798970400000-" + std::to_string(renewalEnd) +
      " amount=7000000000 closed=" + std::to_string(kEnd + 10 * kDay) + " statement=EPOCH/7\n";
  CHECK_EQ(grantsAsText(), underEpoch(reversedAndRefunded, "c09a3ab3"));

  // Restored whole under a new epoch, as one page. Its first read stops in the page, before funding sees it; its second
  // stops after the funding committed. Neither leaves a grant anywhere but at its period's last statement: the bought
  // period never closes on the way, and the refunded renewal never reopens.
  Json::Value whole = pageOf(history);
  whole["epoch"] = contractExample("feed.json", "ledger_restored")["body"]["epoch"];
  feed.serve(0, whole);
  feed.serve(7, restored("caught_up", 7));
  LedgerLines lines;
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("failed"));
  CHECK_EQ(grantsAsText(), underEpoch(reversedAndRefunded, "c09a3ab3"));
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("failed"));
  CHECK_EQ(grantsAsText(), underEpoch(reversedAndRefunded, "2dd74022"));
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("rebuilt"));
  CHECK_EQ(grantsAsText(), underEpoch(reversedAndRefunded, "2dd74022"));
  CHECK_EQ(cursorAsText(), std::string("2dd74022/7"));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{
      "subscription.follow failed/error background",
      "subscription.refund ok/info background", "subscription.refund ok/info background",
      "subscription.follow failed/error background",
      "subscription.refund replay/warn background", "subscription.refund replay/warn background",
      "subscription.follow rebuilt/warn background"}));

  // While it holds its refund, the renewal funds nothing.
  ledger.now = kEnd + 11 * kDay;
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, kAccount}, AiBudgetTier::WindmillOne};
  CHECK_EQ(ledger.budgets.view(principal).tier, AiBudgetTier::LoggedIn);
}

TEST(pg_subscription_fund_a_period_funded_before_the_amount_changed_replays_at_what_it_was_funded_with) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  FakeFeed feed;
  feed.serve(0, recordedAlone(1, kBought, kStart, kEnd));
  {
    Ledger ledger{feed};
    CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  }
  Json::Value again = recordedAlone(1, kBought, kStart, kEnd);
  again["epoch"] = contractExample("feed.json", "ledger_restored")["body"]["epoch"];
  feed.serve(0, again);
  feed.serve(1, restored("caught_up", 1));
  Ledger ledger{feed, {}, 8'000'000'000};
  LedgerLines lines;
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("rebuilt"));
  CHECK_EQ(grantsAsText(), "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86 account=3f6c2a1e 1796292000000-1798970400000 "
                           "amount=7000000000 closed=- statement=2dd74022/1\n");
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"subscription.fund replay/warn background",
                                                    "subscription.follow rebuilt/warn background"}));
  CHECK(ledger.reports.warnings.empty());
}

TEST(pg_subscription_fund_a_refund_closes_the_grant_its_period_funds_whichever_account_the_entry_names) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  Json::Value moved = entryOf(3, 2, "period_refunded", kBought, kStart, kEnd, Json::Int64(kStart + 1000));
  const Json::Value other = ledgerEntry(7);
  moved["accountId"] = other["accountId"];
  moved["entitlement"] = other["entitlement"];
  FakeFeed feed;
  feed.serve(0, recordedAlone(1, kBought, kStart, kEnd));
  feed.serve(1, pageOf({moved}));
  Ledger ledger{feed};
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(grantsAsText(), "e2b8f0a4-7c19-4d6e-a3f5-91c0d7b42e86 account=3f6c2a1e 1796292000000-1798970400000 "
                           "amount=7000000000 closed=" + std::to_string(kStart + 1000) + " statement=c09a3ab3/2\n");
}

TEST(pg_subscription_fund_sandbox_trial_unpaid_refunded_unbound_and_unknown_periods_fund_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  Json::Value trial = entryOf(3, 2, "period_recorded", "2d3e4f50-6172-4c83-9d94-e5f60718293a", kStart, kEnd);
  trial["offerKind"] = "free_trial";
  trial["period"]["offerKind"] = "free_trial";
  trial["period"]["price"]["amount"] = "0.00";
  Json::Value unpriced = entryOf(3, 3, "period_recorded", "3e4f5061-7283-4d94-8ea5-f60718293a4b", kStart, kEnd);
  unpriced["period"]["price"] = Json::Value();
  Json::Value refunded = entryOf(3, 4, "period_recorded", "4f506172-8394-4ea5-9fb6-0718293a4b5c", kStart, kEnd,
                                 Json::Int64(kStart + 1));
  Json::Value unbound = ledgerEntry(5);
  unbound["seq"] = Json::UInt64(5);
  Json::Value gifted = entryOf(3, 6, "period_recorded", "50617283-94a5-4fb6-8ac7-18293a4b5c6d", kStart, kEnd);
  gifted["type"] = "gifted";
  Json::Value sandbox = ledgerEntry(11);
  sandbox["seq"] = Json::UInt64(7);
  Json::Value sandboxRefund = ledgerEntry(11);
  sandboxRefund["seq"] = Json::UInt64(8);
  sandboxRefund["type"] = "period_refunded";
  sandboxRefund["period"]["refundedAt"] = sandboxRefund["occurredAt"];
  Json::Value grace = ledgerEntry(18);
  grace["seq"] = Json::UInt64(9);
  FakeFeed feed;
  feed.serve(0, pageOf({ledgerEntry(1), trial, unpriced, refunded, unbound, gifted, sandbox, sandboxRefund, grace}));
  Ledger ledger{feed};
  LedgerLines lines;

  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("applied"));
  CHECK_EQ(cursorAsText(), std::string("c09a3ab3/9"));
  CHECK_EQ(grantsAsText(), std::string());
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"subscription.follow ok/info background"}));
  CHECK(ledger.reports.warnings.empty());
}

TEST(pg_subscription_fund_a_period_the_ledger_refuses_rolls_the_page_back_and_reports_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger();
  FakeFeed feed;
  // A stretch that ends before it starts is no period a grant can span.
  feed.serve(0, pageOf({ledgerEntry(1), entryOf(3, 2, "period_recorded", kBought, kEnd, kStart)}));
  Ledger ledger{feed};
  LedgerLines lines;

  CHECK_EQ(nameOf(ledger.follower.follow()), std::string("failed"));
  CHECK_EQ(cursorAsText(), std::string("-/0"));
  CHECK_EQ(grantsAsText(), std::string());
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"subscription.fund invalid/error background",
                                                    "subscription.follow failed/error background"}));
  CHECK_EQ(ledger.reports.failures,
           (std::vector<std::string>{"subscription.fund invalid", "subscription.follow failed"}));
}
