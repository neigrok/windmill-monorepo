#include "platform/application/AiBudgetService.h"
#include "platform/application/WriteObservation.h"

#include "test/testing.h"

#include <trantor/utils/Logger.h>

#include <cstdio>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <tuple>
#include <typeinfo>
#include <vector>

using namespace wm;

namespace {

struct BudgetRepository : AiBudgetRepository {
  std::map<std::string, AiBudgetReservation> rows;
  AiBudgetSnapshot totals;
  std::optional<AiBudgetPrincipal> readPrincipal;
  long long readAtMs = 0;
  bool fail = false;
  bool writeOnView = false;
  int calls = 0;
  std::optional<AiBudgetGrant> funded;
  std::pair<std::string, std::string> binding;
  std::vector<AiBudgetAlert> alerts;
  std::tuple<long long, int, long long> claim;
  std::pair<std::string, std::string> delivery;
  long long retryAtMs = 0;
  std::vector<std::tuple<long long, int, std::optional<AiBudgetSubject>>> lapseSweeps;

  AiBudgetSnapshot snapshot(const AiBudgetPrincipal& principal, long long atMs, const AiBudgetLimits&) override {
    ++calls;
    if (fail) throw std::runtime_error("private_database_address");
    readPrincipal = principal;
    readAtMs = atMs;
    auto result = totals;
    if (principal.tier == AiBudgetTier::LoggedIn) result.period = *AiBudgetPeriod::at(atMs);
    if (writeOnView) { markCurrentWrite(); writeOnView = false; }
    return result;
  }

  AiBudgetResult reserve(const AiBudgetRequest& request, const AiBudgetLimits& limits) override {
    ++calls;
    if (fail) throw std::runtime_error("private_database_address");
    const auto found = rows.find(request.id);
    if (found != rows.end())
      return {found->second.sameRequest(request) ? AiBudgetCode::Replay : AiBudgetCode::Conflict, found->second};
    const auto state = snapshot(request.principal, request.atMs, limits);
    const auto code = admitAiBudget(request, limits, state);
    if (code != AiBudgetCode::Ok) return {code};
    AiBudgetReservation reservation{request.id, request.principal.subject, request.principal.tier,
                                     state.period, request.amountNanos};
    reservation.admittedAtMs = request.atMs;
    if (state.grant) reservation.grantId = state.grant->id;
    rows.emplace(request.id, reservation);
    markCurrentWrite();
    return {AiBudgetCode::Ok, reservation};
  }

  AiBudgetResult transition(const std::string& id, AiBudgetState target, std::optional<long long> actual = std::nullopt) {
    ++calls;
    const auto found = rows.find(id);
    if (found == rows.end()) return {AiBudgetCode::NotFound};
    const auto code = transitionAiBudget(found->second, target, actual);
    if (code == AiBudgetCode::Ok) markCurrentWrite();
    return {code, found->second};
  }
  AiBudgetResult markDispatched(const std::string& id) override { return transition(id, AiBudgetState::Dispatched); }
  AiBudgetResult markUncertain(const std::string& id) override { return transition(id, AiBudgetState::Uncertain); }
  AiBudgetResult settle(const std::string& id, long long actual) override { return transition(id, AiBudgetState::Settled, actual); }
  AiBudgetResult release(const std::string& id) override { return transition(id, AiBudgetState::Released); }
  std::vector<AiBudgetReservation> releaseLapsed(long long atMs, int limit,
                                                 const std::optional<AiBudgetSubject>& subject) override {
    ++calls;
    lapseSweeps.emplace_back(atMs, limit, subject);
    if (fail) throw std::runtime_error("private_database_address");
    std::vector<AiBudgetReservation> released;
    for (auto& [id, reservation] : rows) {
      if (static_cast<int>(released.size()) == limit) break;
      if (subject && reservation.subject != *subject) continue;
      if (releaseLapsedAiBudget(reservation, atMs) == AiBudgetCode::Ok) released.push_back(reservation);
    }
    if (!released.empty()) markCurrentWrite();
    return released;
  }
  AiBudgetResult reconcileOverrun(const std::string& id) override {
    ++calls;
    const auto found = rows.find(id);
    if (found == rows.end()) return {AiBudgetCode::NotFound};
    const auto code = reconcileAiBudgetOverrun(found->second);
    if (code == AiBudgetCode::Ok) markCurrentWrite();
    return {code, found->second};
  }
  AiBudgetGrantResult fund(const AiBudgetGrant& grant, const AiBudgetLimits&) override {
    ++calls;
    funded = grant;
    markCurrentWrite();
    return {AiBudgetCode::Ok, grant};
  }
  std::optional<std::string> boundAccount(const std::string& device) override {
    if (binding.first == device) return binding.second;
    return std::nullopt;
  }
  AiBudgetCode bindDevice(const std::string& device, const std::string& account, long long atMs, const AiBudgetLimits&) override {
    ++calls;
    binding = {device, account};
    readAtMs = atMs;
    markCurrentWrite();
    return AiBudgetCode::Ok;
  }
  std::vector<AiBudgetAlert> claimAlerts(long long atMs, int limit, long long leaseUntilMs) override {
    claim = {atMs, limit, leaseUntilMs};
    if (!alerts.empty()) markCurrentWrite();
    return alerts;
  }
  AiBudgetCode completeAlert(const std::string& id, const std::string& token) override {
    delivery = {id, token};
    markCurrentWrite();
    return AiBudgetCode::Ok;
  }
  AiBudgetCode retryAlert(const std::string& id, const std::string& token, long long nextAttemptMs) override {
    delivery = {id, token};
    retryAtMs = nextAttemptMs;
    markCurrentWrite();
    return AiBudgetCode::Ok;
  }
};

struct BudgetFailures : FailureReporter {
  std::vector<std::string> reports;
  std::vector<std::string> warnings;
  void report(const std::string& kind, const std::string& where, const std::string& detail) override {
    reports.push_back(kind + " " + where + " " + detail);
  }
  void reportWarning(const std::string& operation, const std::string& product, const std::string& door,
                     const std::string& outcome, const std::string& requestId,
                     const std::map<std::string, std::string>& tags) override {
    std::string warning = operation + " " + product + " " + door + " " + outcome + " " + requestId;
    for (const auto& [name, value] : tags) warning += " " + name + "=" + value;
    warnings.push_back(warning);
  }
};

struct BudgetObservations {
  std::shared_ptr<BudgetFailures> failures = std::make_shared<BudgetFailures>();
  std::vector<WriteCompletion> lines;
  std::vector<std::string> releaseLines;
  trantor::Logger::LogLevel level = trantor::Logger::logLevel();
  BudgetObservations() {
    installWriteReporter(failures);
    installWriteSink([this](const WriteCompletion& line) { lines.push_back(line); });
    trantor::Logger::setLogLevel(trantor::Logger::kInfo);
    trantor::Logger::setOutputFunction(
        [this](const char* message, std::uint64_t length) {
          const std::string line(message, length);
          const std::size_t start = line.find("ai_hold_");
          if (start != std::string::npos) releaseLines.push_back(line.substr(start, line.rfind(" - ") - start));
        },
        [] {});
  }
  ~BudgetObservations() {
    installWriteSink({});
    installWriteReporter({});
    trantor::Logger::setOutputFunction([](const char* message, std::uint64_t length) { fwrite(message, 1, length, stdout); },
                                       [] { fflush(stdout); });
    trantor::Logger::setLogLevel(level);
  }
};

}

TEST(ai_budget_service_uses_live_policy_and_the_injected_clock) {
  BudgetRepository repository;
  repository.totals.subject = {5, 2};
  AiBudgetLimits limits;
  limits.loggedInMonthlyNanos = 20;
  long long now = 0;
  AiBudgetService service{repository, [&] { return limits; }, [&] { return now; }};
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  const auto first = service.view(principal);
  CHECK_EQ(first.usedNanos, 5);
  CHECK_EQ(first.heldNanos, 2);
  CHECK_EQ(first.remainingNanos, 13);
  CHECK_EQ(first.code, AiBudgetCode::Ok);
  REQUIRE(repository.readPrincipal);
  CHECK_EQ(repository.readPrincipal->subject, principal.subject);
  CHECK_EQ(repository.readPrincipal->tier, principal.tier);
  limits.loggedInMonthlyNanos = 9;
  now = *first.resetsAtMs;
  const auto next = service.view(principal);
  CHECK_EQ(next.remainingNanos, 2);
  CHECK_EQ(repository.readAtMs, now);
  CHECK_EQ(next.resetsAtMs, std::optional<long long>{AiBudgetPeriod::at(now)->endMs});
}

TEST(ai_budget_service_rejects_malformed_admission_funding_and_binding_before_io) {
  BudgetRepository repository;
  long long now = 0;
  AiBudgetService service{repository, [] { return AiBudgetLimits{}; }, [&] { return now; }};
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  CHECK_EQ(service.reserve("bad id", principal, 10).code, AiBudgetCode::Invalid);
  CHECK_EQ(service.reserve("call", principal, 0).code, AiBudgetCode::Invalid);
  CHECK_EQ(service.settle("call", -1).code, AiBudgetCode::Invalid);
  CHECK_EQ(service.markDispatched("").code, AiBudgetCode::Invalid);
  CHECK_EQ(service.bindDevice("device", "bad account"), AiBudgetCode::Invalid);
  CHECK_EQ(service.fund({"grant", "account", AiBudgetFundingSource::Owner, {1, 2}, 7, "funding"}).code,
           AiBudgetCode::Invalid);
  now = -1;
  CHECK_EQ(service.reserve("call", principal, 10).code, AiBudgetCode::Invalid);
  CHECK_EQ(service.view(principal).code, AiBudgetCode::Invalid);
  CHECK_EQ(repository.calls, 0);
}

TEST(ai_budget_service_replays_original_admission_after_month_and_tier_change) {
  BudgetRepository repository;
  long long now = AiBudgetPeriod::at(0)->endMs - 60'000;
  AiBudgetService service{repository, [] { return AiBudgetLimits{}; }, [&] { return now; }};
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  const auto first = service.reserve("call", principal, 10);
  REQUIRE_EQ(first.code, AiBudgetCode::Ok);
  REQUIRE(first.reservation);
  CHECK_EQ(service.markDispatched("call").code, AiBudgetCode::Ok);
  now = first.reservation->period.endMs;
  const auto retry = service.reserve("call", {principal.subject, AiBudgetTier::WindmillOne}, 10);
  REQUIRE_EQ(retry.code, AiBudgetCode::Replay);
  REQUIRE(retry.reservation);
  CHECK_EQ(retry.reservation->tier, AiBudgetTier::LoggedIn);
  CHECK_EQ(retry.reservation->period, first.reservation->period);
  CHECK_EQ(retry.reservation->state, AiBudgetState::Dispatched);
  CHECK_EQ(service.markDispatched("call").code, AiBudgetCode::AlreadyDispatched);
  CHECK_EQ(service.reserve("new", {principal.subject, AiBudgetTier::WindmillOne}, 10).code, AiBudgetCode::FundingRequired);
  CHECK_EQ(repository.rows.size(), std::size_t{1});
}

TEST(ai_budget_service_logs_each_flow_step_with_bounded_metadata_and_no_expected_issues) {
  BudgetObservations observations;
  BudgetRepository repository;
  AiBudgetService service{repository, [] { return AiBudgetLimits{}; }, [] { return 0; }};
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "private_account_id"}, AiBudgetTier::LoggedIn};
  CHECK_EQ(service.reserve("private_call_id", principal, 10).code, AiBudgetCode::Ok);
  CHECK_EQ(service.markDispatched("private_call_id").code, AiBudgetCode::Ok);
  CHECK_EQ(service.markUncertain("private_call_id").code, AiBudgetCode::Ok);
  CHECK_EQ(service.release("private_call_id").code, AiBudgetCode::InvalidState);
  CHECK_EQ(service.settle("private_call_id", 8).code, AiBudgetCode::Ok);
  CHECK_EQ(service.settle("private_call_id", 8).code, AiBudgetCode::Replay);
  std::vector<std::string> outcomes;
  for (const auto& line : observations.lines)
    outcomes.push_back(line.operation + " " + line.product + " " + line.door + " " + line.outcome);
  CHECK_EQ(outcomes, (std::vector<std::string>{
      "ai.budget.reserve platform ai ok", "ai.budget.dispatch platform ai ok",
      "ai.budget.uncertain platform ai ok", "ai.budget.release platform ai invalid_state",
      "ai.budget.settle platform ai ok", "ai.budget.settle platform ai ok"}));
  CHECK(observations.failures->reports.empty());
  REQUIRE(!observations.lines.empty());
  CHECK(observations.lines.back().severity != WriteSeverity::warn);
}

TEST(ai_budget_service_reports_read_and_write_failures_without_database_messages) {
  for (const bool read : {true, false}) {
    BudgetObservations observations;
    BudgetRepository repository;
    repository.fail = true;
    AiBudgetService service{repository, [] { return AiBudgetLimits{}; }, [] { return 0; }};
    const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
    bool threw = false;
    try {
      if (read) service.view(principal);
      else service.reserve("call", principal, 10);
    } catch (const std::runtime_error&) { threw = true; }
    CHECK(threw);
    std::vector<std::string> outcomes;
    for (const auto& line : observations.lines) {
      outcomes.push_back(line.operation + " " + line.outcome);
      CHECK_EQ(line.requestId, observations.lines[0].requestId);
    }
    CHECK_EQ(outcomes, (std::vector<std::string>{"ai.budget.release_lapsed failed",
                                                  read ? "ai.budget.view failed" : "ai.budget.reserve failed"}));
    REQUIRE_EQ(observations.failures->reports.size(), std::size_t{1});
    const auto& first = observations.lines[0];
    CHECK_EQ(observations.failures->reports[0], "platform " + first.operation +
             " door=ai outcome=failed request_id=" + first.requestId + " exception_type=" + typeid(std::runtime_error).name());
    CHECK(observations.failures->warnings.empty());
  }
}

TEST(ai_budget_service_admission_and_reads_release_their_principals_lapsed_holds_and_the_sweep_everyone_elses) {
  BudgetObservations observations;
  BudgetRepository repository;
  const long long admitted = 1'767'225'600'000;
  long long now = admitted;
  AiBudgetService service{repository, [] { return AiBudgetLimits{}; }, [&] { return now; }};
  const AiBudgetPrincipal account{{AiBudgetSubjectKind::Account, "account"}, AiBudgetTier::LoggedIn};
  const AiBudgetPrincipal other{{AiBudgetSubjectKind::Account, "other"}, AiBudgetTier::LoggedIn};
  CHECK_EQ(service.reserve("unsent", account, 10).code, AiBudgetCode::Ok);
  CHECK_EQ(service.reserve("lost", account, 10).code, AiBudgetCode::Ok);
  CHECK_EQ(service.markDispatched("lost").code, AiBudgetCode::Ok);
  now = admitted + 60'000;
  CHECK_EQ(service.reserve("timed-out", account, 10).code, AiBudgetCode::Ok);
  CHECK_EQ(service.markDispatched("timed-out").code, AiBudgetCode::Ok);
  CHECK_EQ(service.markUncertain("timed-out").code, AiBudgetCode::Ok);
  CHECK_EQ(service.reserve("elsewhere", other, 10).code, AiBudgetCode::Ok);
  CHECK_EQ(service.markDispatched("elsewhere").code, AiBudgetCode::Ok);
  CHECK(observations.releaseLines.empty());

  now = admitted + kAiBudgetHoldLifetimeMs - 1;
  CHECK_EQ(service.releaseLapsed(), 0);
  CHECK_EQ(service.reserve("early", account, 10).code, AiBudgetCode::Ok);
  for (const auto* id : {"unsent", "lost", "timed-out", "elsewhere"}) CHECK(repository.rows.at(id).unresolved());

  observations.lines.clear();
  now = admitted + kAiBudgetHoldLifetimeMs;
  CHECK_EQ(service.reserve("next", account, 10).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.rows.at("unsent").releasedFrom, std::optional<AiBudgetState>{AiBudgetState::Reserved});
  CHECK_EQ(repository.rows.at("lost").releasedFrom, std::optional<AiBudgetState>{AiBudgetState::Dispatched});
  for (const auto* id : {"unsent", "lost"}) {
    CHECK_EQ(repository.rows.at(id).state, AiBudgetState::Released);
    CHECK_FALSE(repository.rows.at(id).actualNanos);
  }
  for (const auto* id : {"timed-out", "elsewhere", "early", "next"}) CHECK(repository.rows.at(id).unresolved());
  CHECK_EQ(std::get<0>(repository.lapseSweeps.back()), now);
  CHECK_EQ(std::get<1>(repository.lapseSweeps.back()), 20);
  CHECK_EQ(std::get<2>(repository.lapseSweeps.back()), std::optional<AiBudgetSubject>{account.subject});
  std::vector<std::string> outcomes;
  for (const auto& line : observations.lines) outcomes.push_back(line.operation + " " + line.door + " " + line.outcome);
  CHECK_EQ(outcomes, (std::vector<std::string>{"ai.budget.release_lapsed ai ok", "ai.budget.reserve ai ok"}));
  REQUIRE_EQ(observations.releaseLines.size(), std::size_t{3});
  const std::string released = observations.releaseLines[2].substr(observations.releaseLines[2].rfind('=') + 1);
  CHECK_EQ(released.size(), std::size_t{32});
  CHECK(released != observations.lines[0].requestId);
  CHECK_EQ(observations.releaseLines, (std::vector<std::string>{
      "ai_hold_released operation=ai.budget.release_lapsed door=ai outcome=dispatched age=under_1h request_id=" + released,
      "ai_hold_released operation=ai.budget.release_lapsed door=ai outcome=reserved age=under_1h request_id=" + released,
      "ai_hold_lapses operation=ai.budget.release_lapsed door=ai released=2 dispatched=1 dispatched_nanos=10 "
      "reserved=1 reserved_nanos=10 uncertain=0 uncertain_nanos=0 request_id=" + released}));
  CHECK_EQ(observations.failures->warnings, (std::vector<std::string>{
      "ai.budget.release_lapsed platform ai released " + released + " dispatched=1 reserved=1 uncertain=0"}));
  CHECK_EQ(service.settle("lost", 8).code, AiBudgetCode::InvalidState);
  CHECK_EQ(repository.rows.at("lost").state, AiBudgetState::Released);

  observations.lines.clear();
  now = admitted + 60'000 + kAiBudgetHoldLifetimeMs;
  CHECK_EQ(service.view(other).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.rows.at("elsewhere").releasedFrom, std::optional<AiBudgetState>{AiBudgetState::Dispatched});
  CHECK(repository.rows.at("timed-out").unresolved());
  outcomes.clear();
  for (const auto& line : observations.lines) outcomes.push_back(line.operation + " " + line.door + " " + line.outcome);
  CHECK_EQ(outcomes, (std::vector<std::string>{"ai.budget.release_lapsed ai ok", "ai.budget.view ai ok"}));
  REQUIRE_EQ(observations.releaseLines.size(), std::size_t{5});
  CHECK(observations.releaseLines[3].find("ai_hold_released operation=ai.budget.release_lapsed door=ai outcome=dispatched "
                                         "age=under_1h ") == 0);
  CHECK(observations.releaseLines[4].find("ai_hold_lapses operation=ai.budget.release_lapsed door=ai released=1 "
                                         "dispatched=1 dispatched_nanos=10 reserved=0 ") == 0);
  CHECK_EQ(observations.failures->warnings.size(), std::size_t{2});

  observations.lines.clear();
  now = admitted + 2 * kAiBudgetHoldLifetimeMs + 86'400'000;
  CHECK_EQ(service.releaseLapsed(), 3);
  for (const auto* id : {"timed-out", "early", "next"}) CHECK_EQ(repository.rows.at(id).state, AiBudgetState::Released);
  CHECK_EQ(std::get<2>(repository.lapseSweeps.back()), std::optional<AiBudgetSubject>{});
  REQUIRE_EQ(observations.lines.size(), std::size_t{1});
  CHECK_EQ(observations.lines[0].operation + " " + observations.lines[0].door, "ai.budget.release_lapsed background");
  REQUIRE_EQ(observations.releaseLines.size(), std::size_t{9});
  CHECK(observations.releaseLines[7].find("door=background outcome=uncertain age=over_1d ") != std::string::npos);
  const std::string swept = observations.releaseLines[8].substr(observations.releaseLines[8].rfind('=') + 1);
  CHECK_EQ(observations.releaseLines[8], "ai_hold_lapses operation=ai.budget.release_lapsed door=background released=3 "
           "dispatched=0 dispatched_nanos=0 reserved=2 reserved_nanos=20 uncertain=1 uncertain_nanos=10 request_id=" + swept);
  REQUIRE_EQ(observations.failures->warnings.size(), std::size_t{3});
  CHECK_EQ(observations.failures->warnings[2],
           "ai.budget.release_lapsed platform background released " + swept + " dispatched=0 reserved=2 uncertain=1");
  CHECK(observations.failures->reports.empty());
  observations.lines.clear();
  CHECK_EQ(service.releaseLapsed(), 0);
  CHECK(observations.lines.empty());
}

TEST(ai_budget_service_sweep_pass_releases_at_most_two_hundred_holds_and_no_batch_once_stopping) {
  BudgetObservations observations;
  BudgetRepository repository;
  const long long admitted = 1'767'225'600'000;
  long long now = admitted;
  AiBudgetService service{repository, [] { return AiBudgetLimits{}; }, [&] { return now; }};
  for (int index = 0; index < 250; ++index) {
    const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "account-" + std::to_string(index)},
                                      AiBudgetTier::LoggedIn};
    REQUIRE_EQ(service.reserve("hold-" + std::to_string(index), principal, 10).code, AiBudgetCode::Ok);
  }
  now = admitted + kAiBudgetHoldLifetimeMs;
  CHECK_EQ(service.releaseLapsed([] { return true; }), 0);
  int asked = 0;
  CHECK_EQ(service.releaseLapsed([&] { return ++asked > 1; }), 20);
  CHECK_EQ(service.releaseLapsed(), 200);
  CHECK_EQ(service.releaseLapsed(), 30);
  CHECK_EQ(service.releaseLapsed(), 0);
  for (const auto& [id, hold] : repository.rows) CHECK_EQ(hold.state, AiBudgetState::Released);
  REQUIRE_EQ(observations.failures->warnings.size(), std::size_t{3});
  CHECK(observations.failures->warnings[1].find(" released ") != std::string::npos);
  CHECK(observations.failures->warnings[1].find(" reserved=200 ") != std::string::npos);
  CHECK(observations.failures->reports.empty());
}

TEST(ai_budget_service_observes_owner_grant_side_effects_but_skips_successful_read_logs) {
  BudgetObservations observations;
  BudgetRepository repository;
  repository.totals.period = *AiBudgetPeriod::at(0);
  repository.totals.grant = AiBudgetGrant{"owner-grant", "owner", AiBudgetFundingSource::Owner,
                                        repository.totals.period, 7'000'000'000, "owner-calendar"};
  repository.writeOnView = true;
  AiBudgetService service{repository, [] { return AiBudgetLimits{}; }, [] { return 0; }};
  const AiBudgetPrincipal principal{{AiBudgetSubjectKind::Account, "owner"}, AiBudgetTier::WindmillOne, true};
  CHECK_EQ(service.view(principal).code, AiBudgetCode::Ok);
  CHECK_EQ(service.view(principal).code, AiBudgetCode::Ok);
  REQUIRE_EQ(observations.lines.size(), std::size_t{1});
  CHECK_EQ(observations.lines[0].operation, "ai.budget.view");
  CHECK_EQ(observations.lines[0].outcome, "ok");
  CHECK(observations.failures->reports.empty());
}

TEST(ai_budget_service_passes_funding_binding_and_alert_leases_through_observed_boundaries) {
  BudgetObservations observations;
  BudgetRepository repository;
  AiBudgetService service{repository, [] { return AiBudgetLimits{}; }, [] { return 1000; }};
  const AiBudgetGrant grant{"grant", "account", AiBudgetFundingSource::Subscription,
                            {0, 3'000'000'000}, 7'000'000'000, "transaction"};
  CHECK_EQ(service.fund(grant).code, AiBudgetCode::Ok);
  CHECK_EQ(repository.funded, std::optional<AiBudgetGrant>{grant});
  CHECK_EQ(service.bindDevice("device", "account"), AiBudgetCode::Ok);
  CHECK_EQ(repository.binding, (std::pair<std::string, std::string>{"device", "account"}));
  AiBudgetAlert alert;
  alert.id = "alert";
  alert.claimToken = "lease";
  repository.alerts = {alert};
  const auto alerts = service.claimAlerts(10, 5000);
  REQUIRE_EQ(alerts.size(), std::size_t{1});
  CHECK_EQ(repository.claim, (std::tuple<long long, int, long long>{1000, 10, 6000}));
  CHECK_EQ(service.retryAlert(alert.id, alert.claimToken, 9000), AiBudgetCode::Ok);
  CHECK_EQ(repository.retryAtMs, 9000);
  CHECK_EQ(service.completeAlert(alert.id, alert.claimToken), AiBudgetCode::Ok);
  CHECK_EQ(repository.delivery, (std::pair<std::string, std::string>{"alert", "lease"}));
  std::vector<std::string> operations;
  for (const auto& line : observations.lines) operations.push_back(line.operation + " " + line.outcome);
  CHECK_EQ(operations, (std::vector<std::string>{"ai.budget.fund ok", "ai.budget.bind_device ok",
      "ai.budget.alert.claim ok", "ai.budget.alert.retry ok", "ai.budget.alert.delivered ok"}));
  CHECK(observations.failures->reports.empty());
}
