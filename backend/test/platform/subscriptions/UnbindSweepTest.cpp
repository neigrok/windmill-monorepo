#include "platform/subscriptions/UnbindSweep.h"

#include "platform/application/WriteObservation.h"
#include "platform/subscriptions/PgOwedUnbinds.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <chrono>
#include <cstdlib>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// The sweep over fakes of the store and the service, then the trigger that owes an unbind and the Postgres store under
// WM_PG_TEST (RUNNING.md §7).
using namespace wm;
using namespace wm::subscriptions;

namespace {
constexpr std::int64_t kMinute = 60'000;

struct FakeClock : Clock {
  std::uint64_t now = 1'800'000'000'000;
  std::uint64_t nowMs() override { return now; }
  std::int64_t at() const { return static_cast<std::int64_t>(now); }
};

// The owed unbinds held in memory, due as Postgres answers them: those with no next attempt or one at or before now.
struct FakeOwed : OwedUnbinds {
  std::map<std::string, OwedUnbind> rows;
  bool keepFails = false;

  std::vector<OwedUnbind> due(std::int64_t nowMs, int limit) override {
    std::vector<OwedUnbind> found;
    for (const auto& [account, owed] : rows)
      if ((!owed.nextAttemptMs || *owed.nextAttemptMs <= nowMs) && static_cast<int>(found.size()) < limit)
        found.push_back(owed);
    return found;
  }
  void keep(const OwedUnbind& owed) override {
    if (keepFails) throw std::runtime_error("the store is down");
    rows.at(owed.account.str()) = owed;
  }
  void settle(const UserId& account) override { rows.erase(account.str()); }
};

// The service, answering each call with the next answer queued, and remembering who it was asked about.
struct FakeService : AccountUnbinder {
  std::deque<UnbindAnswer> answers;
  std::vector<std::string> asked;
  UnbindAnswer unbind(const UserId& account) override {
    asked.push_back(account.str());
    UnbindAnswer answer = answers.front();
    answers.pop_front();
    return answer;
  }
};

// The reports filed, each as its operation, outcome and tags, and the request it was filed under.
struct Reports : FailureReporter {
  std::mutex mutex;
  std::vector<std::string> issues;
  std::vector<std::string> requestIds;
  void report(const std::string& kind, const std::string& where, const std::string& detail) override {
    std::lock_guard lock{mutex};
    issues.push_back(kind + " " + where + " " + detail.substr(0, detail.find(" request_id=")));
  }
  void reportWrite(const std::string& operation, const std::string&, const std::string&, const std::string& outcome,
                   const std::string& requestId, const std::string&) override {
    std::lock_guard lock{mutex};
    issues.push_back(operation + " " + outcome);
    requestIds.push_back(requestId);
  }
  void reportFailure(const std::string& operation, const std::string&, const std::string&, const std::string& outcome,
                     const std::string& requestId, const std::map<std::string, std::string>& tags) override {
    std::lock_guard lock{mutex};
    std::string told = operation + " " + outcome;
    for (const auto& [name, value] : tags) told += " " + name + "=" + value;
    issues.push_back(told);
    requestIds.push_back(requestId);
  }
};

// Every `subscription.unbind` line, as outcome/level and its code, while it lives, with the reports filed meanwhile.
class UnbindLines {
public:
  UnbindLines() : reports_(std::make_shared<Reports>()) {
    installWriteReporter(reports_);
    installWriteSink([this](const WriteCompletion& line) {
      if (line.operation != "subscription.unbind") return;
      const char* level = line.severity == WriteSeverity::error  ? "error"
                          : line.severity == WriteSeverity::warn ? "warn"
                          : line.severity == WriteSeverity::info ? "info"
                                                                 : "debug";
      std::lock_guard lock{mutex_};
      lines_.push_back(line.outcome + "/" + level + (line.code.empty() ? "" : " code=" + line.code));
      requestIds_.push_back(line.requestId);
    });
  }
  ~UnbindLines() {
    installWriteSink({});
    installWriteReporter(nullptr);
  }

  std::vector<std::string> taken() {
    std::lock_guard lock{mutex_};
    return std::exchange(lines_, {});
  }
  std::vector<std::string> requestIds() {
    std::lock_guard lock{mutex_};
    return requestIds_;
  }
  Reports& reports() { return *reports_; }

private:
  std::mutex mutex_;
  std::vector<std::string> lines_;
  std::vector<std::string> requestIds_;
  std::shared_ptr<Reports> reports_;
};

const std::string kAda = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61";
const std::string kBo = "9387ec65-ab17-4b8c-b145-fd0d622966db";
}

TEST(unbind_an_owed_unbind_waits_a_doubled_time_up_to_an_hour_and_is_reported_once_owed_five_minutes_then_hourly) {
  const UnbindPace pace;
  OwedUnbind owed{UserId{kAda}, 0};
  std::vector<std::int64_t> waits;
  std::vector<bool> reported;
  std::int64_t now = 0;
  for (int attempt = 0; attempt < 9; ++attempt) {
    reported.push_back(owed.reportDue(now, pace));
    owed = owed.afterAttempt(now, pace);
    waits.push_back((*owed.nextAttemptMs - now) / kMinute);
    now = *owed.nextAttemptMs;
  }

  // Attempts at 0, 1, 3, 7, 15, 31, 63, 123 and 183 minutes owed: the first report at 7, then 123 and 183.
  CHECK_EQ(waits, (std::vector<std::int64_t>{1, 2, 4, 8, 16, 32, 60, 60, 60}));
  CHECK_EQ(reported, (std::vector<bool>{false, false, false, true, false, false, false, true, true}));
  CHECK_EQ(owed.attempts, 9);
  CHECK_EQ(owed.owedSinceMs, std::int64_t{0});
  CHECK_EQ(owed.reportedAtMs, std::optional<std::int64_t>{183 * kMinute});
}

TEST(unbind_the_sweep_settles_what_the_service_took_and_a_short_outage_is_lines_alone_until_five_minutes_owed) {
  UnbindLines lines;
  FakeClock clock;
  FakeOwed owed;
  FakeService service;
  owed.rows.emplace(kAda, OwedUnbind{UserId{kAda}, clock.at()});
  owed.rows.emplace(kBo, OwedUnbind{UserId{kBo}, clock.at()});
  service.answers = {{true, "204"}, {false, "503"}, {false, "unreachable"}};
  UnbindSweep sweep{owed, service, clock};

  sweep.pass();
  const std::int64_t firstAttempt = clock.at();
  clock.now += 6 * kMinute;
  sweep.pass();

  CHECK_EQ(service.asked, (std::vector<std::string>{kAda, kBo, kBo}));
  REQUIRE_EQ(owed.rows.size(), std::size_t{1});
  const OwedUnbind& left = owed.rows.at(kBo);
  CHECK_EQ(left.attempts, 2);
  CHECK_EQ(left.owedSinceMs, firstAttempt);
  CHECK_EQ(left.nextAttemptMs, std::optional<std::int64_t>{clock.at() + 2 * kMinute});
  CHECK_EQ(left.reportedAtMs, std::optional<std::int64_t>{clock.at()});
  CHECK_EQ(lines.taken(),
           (std::vector<std::string>{"ok/info", "owed/warn code=503", "owed/warn code=unreachable"}));
  CHECK_EQ(lines.reports().issues,
           (std::vector<std::string>{"subscription.unbind owed attempt=2 code=unreachable"}));
  CHECK_EQ(lines.reports().requestIds, (std::vector<std::string>{lines.requestIds().at(2)}));
}

TEST(unbind_a_404_is_a_request_that_missed_the_door_and_stays_owed_like_any_answer_but_a_204) {
  UnbindLines lines;
  FakeClock clock;
  FakeOwed owed;
  FakeService service;
  owed.rows.emplace(kAda, OwedUnbind{UserId{kAda}, clock.at() - 10 * kMinute});
  owed.rows.emplace(kBo, OwedUnbind{UserId{kBo}, clock.at() - 10 * kMinute});
  service.answers = {{false, "404"}, {false, "405"}};
  UnbindSweep sweep{owed, service, clock};

  sweep.pass();

  CHECK_EQ(owed.rows.size(), std::size_t{2});
  CHECK_EQ(owed.rows.at(kAda).attempts, 1);
  CHECK_EQ(owed.rows.at(kBo).attempts, 1);
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"owed/warn code=404", "owed/warn code=405"}));
  CHECK_EQ(lines.reports().issues, (std::vector<std::string>{"subscription.unbind owed attempt=1 code=404",
                                                             "subscription.unbind owed attempt=1 code=405"}));
}

TEST(unbind_a_store_that_cannot_keep_an_attempt_fails_its_line_and_ends_the_pass) {
  UnbindLines lines;
  FakeClock clock;
  FakeOwed owed;
  FakeService service;
  owed.rows.emplace(kAda, OwedUnbind{UserId{kAda}, clock.at()});
  owed.rows.emplace(kBo, OwedUnbind{UserId{kBo}, clock.at()});
  owed.keepFails = true;
  service.answers = {{false, "timeout"}, {false, "timeout"}};
  UnbindSweep sweep{owed, service, clock};

  sweep.pass();

  CHECK_EQ(service.asked, (std::vector<std::string>{kAda}));
  CHECK_EQ(owed.rows.at(kAda).attempts, 0);
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"failed/error"}));
  CHECK_EQ(lines.reports().issues, (std::vector<std::string>{"subscription.unbind failed"}));
}

namespace {
// No owed unbind at all: every case that deletes a users row leaves one behind, through the trigger.
void freshOwed() {
  PgLease lease{*pgTestPool()};
  pqxx::work txn{*lease};
  txn.exec("DELETE FROM users WHERE id IN ('" + kAda + "', '" + kBo + "')");
  txn.exec("DELETE FROM owed_subscription_unbinds");
  txn.commit();
}

std::vector<std::string> owedAsText() {
  PgLease lease{*pgTestPool()};
  pqxx::read_transaction txn{*lease};
  const pqxx::result rows = txn.exec(
      "SELECT account_id::text, attempts, coalesce(next_attempt_ms::text, '-'), coalesce(reported_at_ms::text, '-') "
      "FROM owed_subscription_unbinds WHERE account_id IN ('" + kAda + "', '" + kBo + "') ORDER BY account_id");
  std::vector<std::string> text;
  for (pqxx::result::size_type at = 0; at < rows.size(); ++at)
    text.push_back(rows[at][0].as<std::string>() + " attempts=" + rows[at][1].as<std::string>() +
                   " next=" + rows[at][2].as<std::string>() + " reported=" + rows[at][3].as<std::string>());
  return text;
}
}

TEST(pg_unbind_any_delete_of_a_users_row_owes_its_unbind_once_and_the_store_keeps_and_settles_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshOwed();
  for (int deleted = 0; deleted < 2; ++deleted) {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec("INSERT INTO users (id, email) VALUES ('" + kAda + "', 'unbind-ada-pgtest@example.com'), ('" + kBo +
             "', 'unbind-bo-pgtest@example.com')");
    txn.exec("DELETE FROM users WHERE id IN ('" + kAda + "', '" + kBo + "')");
    txn.commit();
  }
  int told = 0;
  const AccountErasure erasure = unbindOnErasure([&] { ++told; });
  erasure.committed({});
  PgOwedUnbinds store{pgTestPool()};
  const std::int64_t before = static_cast<std::int64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());

  const std::vector<OwedUnbind> due = store.due(0, 10);
  store.keep(due.at(0).afterAttempt(1'000, UnbindPace{}));
  store.settle(UserId{kBo});

  CHECK(erasure.statements.empty());
  CHECK_EQ(told, 1);
  REQUIRE_EQ(due.size(), std::size_t{2});
  CHECK_EQ(due[0].account.str(), kAda);
  CHECK_EQ(due[1].account.str(), kBo);
  CHECK(due[0].owedSinceMs > before - 60'000 && due[0].owedSinceMs <= before);
  CHECK_EQ(due[0].attempts, 0);
  CHECK_EQ(owedAsText(), (std::vector<std::string>{kAda + " attempts=1 next=61000 reported=-"}));
  CHECK(store.due(60'999, 10).empty());
  CHECK_EQ(store.due(61'000, 10).size(), std::size_t{1});
  freshOwed();
}
