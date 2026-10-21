#include "platform/application/AiBudgetAlerts.h"
#include "test/platform/Fakes.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

TEST(ai_budget_alerts_deliver_only_to_configured_owner_and_retry_failed_sends) {
  struct Mail : FakeEmail {
    bool accepted = false;
    std::vector<std::pair<Email, AiBudgetAlert>> alerts;
    void sendAiAllowanceAlert(const Email& recipient, const AiBudgetAlert& alert,
                              std::function<void(bool)> done) override {
      alerts.emplace_back(recipient, alert);
      done(accepted);
    }
  };
  struct Reports : FailureReporter {
    int count = 0;
    void report(const std::string&, const std::string&, const std::string&) override { ++count; }
  };
  struct ReportScope {
    std::shared_ptr<Reports> reports = std::make_shared<Reports>();
    ReportScope() { installWriteReporter(reports); }
    ~ReportScope() { installWriteReporter(nullptr); }
  } scope;
  FakeAiBudgetRepository repository;
  auto clock = std::make_shared<FakeClock>();
  auto service = std::make_shared<AiBudgetService>(repository, [] { return AiBudgetLimits{}; },
                                                   [clock] { return clock->now; });
  auto email = std::make_shared<Mail>();
  AiBudgetAlerts worker{service, email, clock, Email{"owner@example.com"}};
  repository.alerts.push_back({"alert-50", AiBudgetScope::FreeDay, *AiBudgetPeriod::dayAt(clock->now),
                               50, 5'000'000'000, 1'000'000'000, 1'500'000'000, "claim-one", static_cast<long long>(clock->now) + 60'000});
  worker.run();
  CHECK(repository.completedAlerts.empty());
  CHECK(repository.retriedAlerts == std::vector<std::string>{"alert-50"});
  CHECK_EQ(scope.reports->count, 1);
  email->accepted = true;
  repository.alerts[0].claimToken = "claim-two";
  worker.run();
  CHECK(repository.completedAlerts == std::vector<std::string>{"alert-50"});
  REQUIRE_EQ(email->alerts.size(), 2u);
  CHECK_EQ(email->alerts[0].first.value, std::string{"owner@example.com"});
  CHECK_EQ(email->alerts[1].first.value, std::string{"owner@example.com"});
  CHECK_EQ(email->alerts[0].second.id, email->alerts[1].second.id);
  CHECK_EQ(email->alerts[1].second.thresholdPercent, 50);
  CHECK(email->alerts[1].second.scope == AiBudgetScope::FreeDay);
  CHECK_EQ(scope.reports->count, 1);
}
