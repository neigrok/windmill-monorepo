#include "platform/ai_installations/PgAiInstallations.h"
#include "platform/adapters/postgres/PgAiBudgetRepository.h"
#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "test/PgTestPool.h"
#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <array>
#include <barrier>
#include <thread>

using namespace wm;

TEST(pg_ai_installations_keep_opaque_credentials_rate_limits_and_replays_across_restart) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease connection{*pgTestPool()};
    pqxx::work txn{*connection};
    txn.exec("DELETE FROM gym_coach_onboarding; DELETE FROM ai_installation_network_admissions; "
             "DELETE FROM ai_installation_network_limits; DELETE FROM ai_installations; "
             "DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  fake::FakeClock clock;
  clock.now = 1'792'281'600'000;
  const AiBudgetLimits limits;
  PgAiBudgetRepository budgetRows{pgTestPool()};
  auto budgets = std::make_shared<AiBudgetService>(budgetRows, [=] { return limits; }, [&] { return clock.now; });
  OpenSslTokenGenerator tokens;
  PgAiInstallations rows{pgTestPool()};
  AiInstallations installations{rows, budgets, tokens, clock, std::string(32, 'k'), {2, 2}};
  const auto first = installations.issue("192.0.2.1");
  const auto second = installations.issue("192.0.2.1");
  REQUIRE(first.principal);
  REQUIRE(second.principal);
  CHECK_EQ(installations.issue("192.0.2.1").code, AiInstallationCode::RateLimited);
  CHECK_EQ(installations.admitGeneration(*first.principal, "request-one", "192.0.2.1"), AiInstallationCode::Ok);
  CHECK_EQ(installations.admitGeneration(*first.principal, "request-one", "192.0.2.2"), AiInstallationCode::Replay);
  CHECK_EQ(installations.admitGeneration(*second.principal, "request-two", "192.0.2.1"), AiInstallationCode::Ok);
  PgAiInstallations restartedRows{pgTestPool()};
  AiInstallations restarted{restartedRows, budgets, tokens, clock, std::string(32, 'k'), {2, 2}};
  const auto recovered = restarted.authenticate(first.credential);
  REQUIRE(recovered);
  CHECK_EQ(recovered->id(), first.principal->id());
  CHECK_EQ(restarted.admitGeneration(*recovered, "request-one", "192.0.2.1"), AiInstallationCode::Replay);
  CHECK_EQ(restarted.admitGeneration(*recovered, "request-three", "192.0.2.1"), AiInstallationCode::RateLimited);
  CHECK_FALSE(restarted.authenticate(std::string(43, 'x')));
  {
    PgLease connection{*pgTestPool()};
    pqxx::read_transaction txn{*connection};
    const auto stored = txn.exec("SELECT token_digest FROM ai_installations ORDER BY token_digest");
    CHECK_EQ(stored.size(), std::size_t{2});
    for (const auto row : stored) {
      CHECK_EQ(row[0].as<std::string>().size(), std::size_t{64});
      CHECK_FALSE(row[0].as<std::string>() == first.credential);
      CHECK_FALSE(row[0].as<std::string>() == second.credential);
    }
    const auto networks = txn.exec("SELECT network_digest, count FROM ai_installation_network_limits ORDER BY network_digest");
    CHECK_EQ(networks.size(), std::size_t{2});
    for (const auto row : networks) {
      CHECK_EQ(row[0].as<std::string>().size(), std::size_t{64});
      CHECK_EQ(row[1].as<int>(), 2);
    }
    CHECK_EQ(txn.exec("SELECT count(*) FROM ai_installation_network_admissions")[0][0].as<int>(), 2);
  }
  clock.now += 86'400'000;
  restarted.prune();
  {
    PgLease connection{*pgTestPool()};
    pqxx::read_transaction txn{*connection};
    CHECK_EQ(txn.exec("SELECT count(*) FROM ai_installation_network_limits")[0][0].as<int>(), 0);
    CHECK_EQ(txn.exec("SELECT count(*) FROM ai_installation_network_admissions")[0][0].as<int>(), 0);
    CHECK_EQ(txn.exec("SELECT count(*) FROM ai_installations")[0][0].as<int>(), 2);
  }
  CHECK_EQ(restarted.issue("192.0.2.1").code, AiInstallationCode::Ok);
}

TEST(pg_ai_installation_network_issuance_and_generation_are_atomic_under_races) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease connection{*pgTestPool()};
    pqxx::work txn{*connection};
    txn.exec("DELETE FROM gym_coach_onboarding; DELETE FROM ai_installation_network_admissions; "
             "DELETE FROM ai_installation_network_limits; DELETE FROM ai_installations");
    txn.commit();
  }
  fake::FakeClock clock;
  clock.now = 1'792'281'600'000;
  const AiBudgetLimits limits;
  PgAiBudgetRepository budgetRows{pgTestPool()};
  auto budgets = std::make_shared<AiBudgetService>(budgetRows, [=] { return limits; }, [&] { return clock.now; });
  OpenSslTokenGenerator tokens;
  PgAiInstallations rows{pgTestPool()};
  AiInstallations installations{rows, budgets, tokens, clock, std::string(32, 'k'), {3, 2}};
  std::array<AiInstallationIssue, 12> issues;
  std::array<std::exception_ptr, 12> failures;
  std::barrier start{12};
  std::vector<std::thread> calls;
  for (int index = 0; index < 12; ++index) calls.emplace_back([&, index] {
    start.arrive_and_wait();
    try { issues[index] = installations.issue("192.0.2.44"); }
    catch (...) { failures[index] = std::current_exception(); }
  });
  for (auto& call : calls) call.join();
  int accepted = 0;
  std::optional<AiInstallationPrincipal> principal;
  for (int index = 0; index < 12; ++index) {
    CHECK_FALSE(failures[index]);
    if (issues[index].principal) { ++accepted; principal = issues[index].principal; }
    else CHECK_EQ(issues[index].code, AiInstallationCode::RateLimited);
  }
  CHECK_EQ(accepted, 3);
  REQUIRE(principal);
  calls.clear();
  std::array<AiInstallationCode, 12> admissions;
  std::barrier generations{12};
  for (int index = 0; index < 12; ++index) calls.emplace_back([&, index] {
    generations.arrive_and_wait();
    try { admissions[index] = installations.admitGeneration(*principal, "same-request", "192.0.2.44"); }
    catch (...) { failures[index] = std::current_exception(); }
  });
  for (auto& call : calls) call.join();
  int fresh = 0;
  int replay = 0;
  for (int index = 0; index < 12; ++index) {
    CHECK_FALSE(failures[index]);
    if (admissions[index] == AiInstallationCode::Ok) ++fresh;
    if (admissions[index] == AiInstallationCode::Replay) ++replay;
  }
  CHECK_EQ(fresh, 1);
  CHECK_EQ(replay, 11);
  CHECK_EQ(installations.admitGeneration(*principal, "other-request", "192.0.2.44"), AiInstallationCode::Ok);
  CHECK_EQ(installations.admitGeneration(*principal, "third-request", "192.0.2.44"), AiInstallationCode::RateLimited);
}

TEST(pg_ai_installation_binding_preserves_lifetime_spend_holds_and_account_erasure_tombstones) {
  if (!std::getenv("WM_PG_TEST")) SKIP("needs WM_PG_TEST");
  {
    PgLease connection{*pgTestPool()};
    pqxx::work txn{*connection};
    txn.exec("DELETE FROM gym_coach_onboarding; DELETE FROM ai_installation_network_admissions; "
             "DELETE FROM ai_installation_network_limits; DELETE FROM ai_installations; "
             "DELETE FROM ai_budget_alerts; DELETE FROM ai_budget_reservations; DELETE FROM ai_budget_balances; "
             "DELETE FROM ai_budget_grants; DELETE FROM ai_budget_device_accounts");
    txn.commit();
  }
  fake::FakeClock clock;
  clock.now = 1'792'281'600'000;
  const AiBudgetLimits limits;
  PgAiBudgetRepository budgetRows{pgTestPool()};
  auto budgets = std::make_shared<AiBudgetService>(budgetRows, [=] { return limits; }, [&] { return clock.now; });
  OpenSslTokenGenerator tokens;
  PgAiInstallations rows{pgTestPool()};
  AiInstallations installations{rows, budgets, tokens, clock, std::string(32, 'k')};
  const auto issued = installations.issue("192.0.2.1");
  REQUIRE(issued.principal);
  const AiBudgetPrincipal anonymous{{AiBudgetSubjectKind::Device, issued.principal->id()}, AiBudgetTier::Anonymous};
  REQUIRE(budgets->reserve("anonymous-charge", anonymous, 20'000'000).reservation);
  CHECK_EQ(budgets->markDispatched("anonymous-charge").code, AiBudgetCode::Ok);
  CHECK_EQ(budgets->settle("anonymous-charge", 10'000'000).code, AiBudgetCode::Ok);
  REQUIRE(budgets->reserve("anonymous-unknown", anonymous, 15'000'000).reservation);
  CHECK_EQ(budgets->markDispatched("anonymous-unknown").code, AiBudgetCode::Ok);
  CHECK_EQ(budgets->markUncertain("anonymous-unknown").code, AiBudgetCode::Ok);
  const UserId account{"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"};
  {
    PgLease connection{*pgTestPool()};
    pqxx::work txn{*connection};
    txn.exec("INSERT INTO users (id, email, name) VALUES ($1::uuid, 'installation-erasure@example.test', 'Test') ON CONFLICT (id) DO NOTHING", pqxx::params{account.str()});
    txn.commit();
  }
  CHECK_EQ(installations.bind(*issued.principal, account), AiBudgetCode::Ok);
  CHECK_EQ(installations.bind(*issued.principal, account), AiBudgetCode::Replay);
  CHECK_EQ(installations.bind(*issued.principal, UserId{"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}), AiBudgetCode::Conflict);
  const auto view = budgets->view({{AiBudgetSubjectKind::Account, account.str()}, AiBudgetTier::LoggedIn});
  CHECK_EQ(view.usedNanos, 10'000'000);
  CHECK_EQ(view.heldNanos, 15'000'000);
  CHECK_EQ(view.remainingNanos, 225'000'000);
  CHECK_EQ(view.code, AiBudgetCode::ConcurrencyExhausted);
  CHECK_EQ(budgets->reserve("bound-refused", anonymous, 1'000'000).code, AiBudgetCode::DeviceBound);
  {
    PgLease connection{*pgTestPool()};
    pqxx::work txn{*connection};
    txn.exec("DELETE FROM users WHERE id = $1::uuid", pqxx::params{account.str()});
    txn.commit();
  }
  PgAiInstallations restartedRows{pgTestPool()};
  AiInstallations restarted{restartedRows, budgets, tokens, clock, std::string(32, 'k')};
  const auto recovered = restarted.authenticate(issued.credential);
  REQUIRE(recovered);
  CHECK_EQ(recovered->boundAccount(), std::optional<std::string>{account.str()});
  CHECK_EQ(restarted.admitGeneration(*recovered, "after-erasure", "192.0.2.1"), AiInstallationCode::DeviceBound);
  AiInstallations disabled{restartedRows, budgets, tokens, clock};
  const auto retained = disabled.authenticate(issued.credential);
  REQUIRE(retained);
  CHECK_EQ(retained->boundAccount(), std::optional<std::string>{account.str()});
  CHECK_EQ(disabled.bind(*retained, account), AiBudgetCode::Replay);
  CHECK_EQ(disabled.bind(*retained, UserId{"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}), AiBudgetCode::Conflict);
  CHECK_EQ(disabled.admitGeneration(*retained, "disabled-after-erasure", "192.0.2.1"), AiInstallationCode::Unavailable);
  CHECK_EQ(disabled.issue("192.0.2.1").code, AiInstallationCode::Unavailable);
  CHECK_EQ(disabled.allowance(*retained).code, AiBudgetCode::DeviceBound);
  clock.now = AiBudgetPeriod::at(clock.now)->endMs;
  CHECK_EQ(budgets->view(anonymous).code, AiBudgetCode::DeviceBound);
  CHECK_EQ(budgets->view(anonymous).usedNanos, 10'000'000);
  const auto nextMonth = budgets->view({{AiBudgetSubjectKind::Account, account.str()}, AiBudgetTier::LoggedIn});
  CHECK_EQ(nextMonth.usedNanos, 0);
  CHECK_EQ(nextMonth.heldNanos, 15'000'000);
  CHECK_EQ(nextMonth.remainingNanos, 235'000'000);
}
