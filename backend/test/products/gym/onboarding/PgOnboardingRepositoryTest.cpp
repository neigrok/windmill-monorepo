#include "products/gym/onboarding/PgOnboardingRepository.h"
#include "platform/adapters/json/JsonText.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <cstdlib>
#include <future>
#include <pqxx/pqxx>

using namespace wm;
using namespace wm::gym;

TEST(pg_gym_onboarding_claims_once_under_concurrency_and_replays_after_repository_restart) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  const std::string device="installation-onboarding-a";
  {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec_params("DELETE FROM gym_coach_onboarding WHERE device_id=$1",device);
    txn.exec_params("INSERT INTO ai_installations(id,token_digest,created_at_ms) VALUES($1,$2,100) ON CONFLICT(id) DO NOTHING",device,std::string(64,'a'));
    txn.commit();
  }
  PgOnboardingRepository repository{pgTestPool()};
  OnboardingRecord proposed{.deviceId=device,.requestId="12345678-1234-1234-1234-123456789abc",.inputHash=std::string(64,'b'),.resultId="onb_result",.createdAtMs=100,.leaseUntilMs=1000,.expiresAtMs=2000};
  auto a=std::async(std::launch::async,[&]{return repository.claim(proposed);});
  auto b=std::async(std::launch::async,[&]{return repository.claim(proposed);});
  const auto first=a.get();
  const auto second=b.get();
  REQUIRE(first.record);
  REQUIRE(second.record);
  CHECK(first.created != second.created);
  CHECK_EQ(first.record->resultId,second.record->resultId);
  auto changed=proposed;
  changed.inputHash=std::string(64,'c');
  CHECK_EQ(repository.claim(changed).refusal,"request_conflict");
  proposed.state="completed";
  proposed.payload=parse(R"({"routines":[{"name":"Push","entries":[{"exerciseId":"bench-press","sets":[{"reps":8,"weightKg":null}],"restSeconds":120}]}]})");
  CHECK(repository.finish(proposed,500));
  CHECK_FALSE(repository.finish(proposed,501));
  PgOnboardingRepository restarted{pgTestPool()};
  const auto saved=restarted.get(device,proposed.requestId,900);
  REQUIRE(saved);
  CHECK_EQ(saved->state,"completed");
  CHECK_EQ(saved->payload,proposed.payload);
  CHECK_EQ(saved->terminalAtMs,500);
  CHECK_FALSE(restarted.get("another-device",proposed.requestId,900));
  const auto replay=restarted.claim(proposed);
  REQUIRE(replay.record);
  CHECK_FALSE(replay.created);
  CHECK_EQ(replay.record->payload,proposed.payload);
  restarted.expire(2000);
  const auto expired=restarted.get(device,proposed.requestId,2000);
  REQUIRE(expired);
  CHECK_EQ(expired->state,"expired");
  CHECK(expired->payload.isNull());
  CHECK_EQ(expired->inputHash,proposed.inputHash);
  CHECK_FALSE(restarted.claim(proposed).created);
}

TEST(pg_gym_onboarding_pending_deadline_is_terminal_and_daily_request_limit_renews) {
  if (!std::getenv("WM_PG_TEST")) SKIP("set WM_PG_TEST=1 for Postgres");
  const std::string device="installation-onboarding-b";
  {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec_params("DELETE FROM gym_coach_onboarding WHERE device_id=$1",device);
    txn.exec_params("INSERT INTO ai_installations(id,token_digest,created_at_ms) VALUES($1,$2,100) ON CONFLICT(id) DO NOTHING",device,std::string(64,'d'));
    txn.commit();
  }
  PgOnboardingRepository repository{pgTestPool()};
  OnboardingRecord record{.deviceId=device,.inputHash=std::string(64,'e'),.resultId="onb_result",.createdAtMs=100,.leaseUntilMs=1000,.expiresAtMs=86'400'000};
  for (int index=0;index<8;++index) {
    record.requestId="request-"+std::to_string(index);
    CHECK(repository.claim(record).created);
  }
  record.requestId="request-8";
  CHECK_EQ(repository.claim(record).refusal,"request_limit");
  const auto stale=repository.get(device,"request-0",1000);
  REQUIRE(stale);
  CHECK_EQ(stale->state,"failed");
  CHECK_EQ(stale->errorCode,"interrupted");
  auto late=*stale;
  late.state="completed";
  late.payload=parse(R"({"routines":[]})");
  CHECK_FALSE(repository.finish(late,1000));
  record.createdAtMs=86'400'100;
  record.leaseUntilMs=86'401'000;
  record.expiresAtMs=172'800'000;
  CHECK(repository.claim(record).created);
  repository.expire(86'400'100);
  const auto old=repository.get(device,"request-0",86'400'100);
  REQUIRE(old);
  CHECK_EQ(old->state,"expired");
  CHECK(old->payload.isNull());
}
