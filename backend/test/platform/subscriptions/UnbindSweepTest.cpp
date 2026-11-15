#include "platform/subscriptions/UnbindSweep.h"

#include "platform/application/WriteObservation.h"
#include "platform/subscriptions/PgOwedUnbinds.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// The sweep over fakes of the store and the service, then the Postgres store and the erasure's share under WM_PG_TEST
// (RUNNING.md §7).
using namespace wm;
using namespace wm::subscriptions;

namespace {
constexpr std::int64_t kMinute = 60'000;

struct FakeClock : Clock {
  std::uint64_t now = 1'800'000'000'000;
  std::uint64_t nowMs() override { return now; }
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

struct Reports : FailureReporter {
  std::mutex mutex;
  std::vector<std::string> issues;
  std::vector<std::string> warnings;
  void report(const std::string& kind, const std::string& where, const std::string& detail) override {
    std::lock_guard lock{mutex};
    issues.push_back(kind + " " + where + " " + detail.substr(0, detail.find(" request_id=")));
  }
  void reportWarning(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string&, const std::map<std::string, std::string>&) override {
    std::lock_guard lock{mutex};
    warnings.push_back(operation + " " + product + " " + door + " " + outcome);
  }
};

// Every `subscription.unbind` line, as outcome/level, while it lives, with the reports filed meanwhile.
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
      lines_.push_back(line.outcome + "/" + level + " " + line.product + " " + line.door);
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
  Reports& reports() { return *reports_; }

private:
  std::mutex mutex_;
  std::vector<std::string> lines_;
  std::shared_ptr<Reports> reports_;
};

const std::string kAda = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61";
const std::string kBo = "9387ec65-ab17-4b8c-b145-fd0d622966db";
}

TEST(unbind_an_owed_unbind_waits_a_doubled_time_up_to_an_hour_and_is_reported_once_a_window) {
  const UnbindPace pace;
  OwedUnbind owed{UserId{kAda}};
  std::vector<std::int64_t> waits;
  std::vector<bool> reported;
  std::int64_t now = 0;
  for (int attempt = 0; attempt < 9; ++attempt) {
    reported.push_back(owed.reportDue(now, pace));
    owed = owed.afterAttempt(now, pace);
    waits.push_back((*owed.nextAttemptMs - now) / kMinute);
    now = *owed.nextAttemptMs;
  }

  CHECK_EQ(waits, (std::vector<std::int64_t>{1, 2, 4, 8, 16, 32, 60, 60, 60}));
  CHECK_EQ(reported, (std::vector<bool>{true, false, false, false, false, false, true, true, true}));
  CHECK_EQ(owed.attempts, 9);
  CHECK_EQ(owed.reportedAtMs, std::optional<std::int64_t>{now - 60 * kMinute});
}

TEST(unbind_the_sweep_settles_what_the_service_took_and_keeps_owed_what_it_did_not) {
  UnbindLines lines;
  FakeClock clock;
  FakeOwed owed;
  FakeService service;
  owed.rows.emplace(kAda, OwedUnbind{UserId{kAda}});
  owed.rows.emplace(kBo, OwedUnbind{UserId{kBo}});
  service.answers = {{true, "204"}, {false, "503"}};
  UnbindSweep sweep{owed, service, clock};

  sweep.pass();
  clock.now += 30'000;
  sweep.pass();

  CHECK_EQ(service.asked, (std::vector<std::string>{kAda, kBo}));
  REQUIRE_EQ(owed.rows.size(), std::size_t{1});
  const OwedUnbind& left = owed.rows.at(kBo);
  CHECK_EQ(left.attempts, 1);
  CHECK_EQ(left.nextAttemptMs, std::optional<std::int64_t>{static_cast<std::int64_t>(clock.now) - 30'000 + kMinute});
  CHECK_EQ(left.reportedAtMs, std::optional<std::int64_t>{static_cast<std::int64_t>(clock.now) - 30'000});
  CHECK_EQ(lines.taken(),
           (std::vector<std::string>{"ok/info platform background", "owed/error platform background"}));
  CHECK_EQ(lines.reports().issues,
           (std::vector<std::string>{"platform subscription.unbind door=background outcome=owed"}));
  CHECK(lines.reports().warnings.empty());
}

TEST(unbind_a_retry_inside_the_window_is_a_line_and_no_report_and_a_404_settles_with_a_warning) {
  UnbindLines lines;
  FakeClock clock;
  FakeOwed owed;
  FakeService service;
  owed.rows.emplace(kAda, OwedUnbind{UserId{kAda}, 3, std::nullopt, static_cast<std::int64_t>(clock.now) - kMinute});
  owed.rows.emplace(kBo, OwedUnbind{UserId{kBo}, 0, static_cast<std::int64_t>(clock.now) + kMinute, std::nullopt});
  service.answers = {{false, "unreachable"}, {true, "404"}};
  UnbindSweep sweep{owed, service, clock};

  sweep.pass();
  clock.now += 2 * kMinute;
  owed.rows.at(kAda).nextAttemptMs = static_cast<std::int64_t>(clock.now) + kMinute;
  sweep.pass();

  CHECK_EQ(service.asked, (std::vector<std::string>{kAda, kBo}));
  REQUIRE_EQ(owed.rows.size(), std::size_t{1});
  CHECK_EQ(owed.rows.at(kAda).attempts, 4);
  CHECK_EQ(lines.taken(),
           (std::vector<std::string>{"owed/warn platform background", "not_found/warn platform background"}));
  CHECK(lines.reports().issues.empty());
  CHECK_EQ(lines.reports().warnings,
           (std::vector<std::string>{"subscription.unbind platform background not_found"}));
}

TEST(unbind_a_store_that_cannot_keep_an_attempt_fails_its_line_and_ends_the_pass) {
  UnbindLines lines;
  FakeClock clock;
  FakeOwed owed;
  FakeService service;
  owed.rows.emplace(kAda, OwedUnbind{UserId{kAda}});
  owed.rows.emplace(kBo, OwedUnbind{UserId{kBo}});
  owed.keepFails = true;
  service.answers = {{false, "timeout"}, {false, "timeout"}};
  UnbindSweep sweep{owed, service, clock};

  sweep.pass();

  CHECK_EQ(service.asked, (std::vector<std::string>{kAda}));
  CHECK_EQ(owed.rows.at(kAda).attempts, 0);
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"failed/error platform background"}));
  CHECK_EQ(lines.reports().issues,
           (std::vector<std::string>{"platform subscription.unbind door=background outcome=failed"}));
}

namespace {
void freshOwed() {
  PgLease lease{*pgTestPool()};
  pqxx::work txn{*lease};
  txn.exec("DELETE FROM owed_subscription_unbinds WHERE account_id IN ('" + kAda + "', '" + kBo + "')");
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

TEST(pg_unbind_the_erasure_records_its_unbind_once_and_the_store_keeps_and_settles_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshOwed();
  int told = 0;
  const AccountErasure erasure = unbindOnErasure([&] { ++told; });
  REQUIRE_EQ(erasure.statements.size(), std::size_t{1});
  std::vector<std::string> recorded;
  for (int erased = 0; erased < 2; ++erased) {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    for (const std::string& account : {kAda, kBo}) {
      const pqxx::result rows = txn.exec(erasure.statements[0], pqxx::params{account});
      for (pqxx::result::size_type at = 0; at < rows.size(); ++at) recorded.push_back(rows[at][0].as<std::string>());
    }
    txn.commit();
    erasure.committed(recorded);
    recorded.clear();
  }
  PgOwedUnbinds store{pgTestPool()};

  const std::vector<OwedUnbind> due = store.due(0, 10);
  OwedUnbind later = due.at(0);
  later = later.afterAttempt(1'000, UnbindPace{});
  store.keep(later);
  store.settle(UserId{kBo});

  CHECK_EQ(told, 1);
  REQUIRE_EQ(due.size(), std::size_t{2});
  CHECK_EQ(due[0].account.str(), kAda);
  CHECK_EQ(due[1].account.str(), kBo);
  CHECK_EQ(owedAsText(), (std::vector<std::string>{kAda + " attempts=1 next=61000 reported=1000"}));
  CHECK(store.due(60'999, 10).empty());
  CHECK_EQ(store.due(61'000, 10).size(), std::size_t{1});
  freshOwed();
}
