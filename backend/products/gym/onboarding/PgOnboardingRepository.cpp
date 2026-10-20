#include "products/gym/onboarding/PgOnboardingRepository.h"

#include "platform/adapters/json/JsonText.h"
#include "platform/application/WriteObservation.h"

#include <pqxx/pqxx>

namespace wm::gym {
namespace {

template <typename Row>
OnboardingRecord readRecord(const Row& row) {
  return {row["device_id"].template as<std::string>(), row["request_id"].template as<std::string>(),
          row["input_hash"].template as<std::string>(), row["result_id"].template as<std::string>(),
          row["state"].template as<std::string>(), row["payload"].is_null() ? Json::Value() : parse(row["payload"].template as<std::string>()),
          row["error_code"].template as<std::string>(), row["created_at_ms"].template as<long long>(),
          row["lease_until_ms"].template as<long long>(), row["expires_at_ms"].template as<long long>(),
          row["terminal_at_ms"].template as<long long>()};
}

}

PgOnboardingRepository::PgOnboardingRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

OnboardingClaim PgOnboardingRepository::claim(const OnboardingRecord& proposed) {
  PgLease lease{*pool_};
  pqxx::work txn{*lease};
  txn.exec_params("SELECT id FROM ai_installations WHERE id=$1 FOR UPDATE", proposed.deviceId);
  const auto rows = txn.exec_params("SELECT * FROM gym_coach_onboarding WHERE device_id=$1 AND request_id=$2",
                                    proposed.deviceId, proposed.requestId);
  if (!rows.empty()) {
    auto record = expireOnboarding(readRecord(rows[0]), proposed.createdAtMs);
    if (record.inputHash != proposed.inputHash) return {std::nullopt, false, "request_conflict"};
    return {std::move(record), false, {}};
  }
  const auto count = txn.exec_params("SELECT count(*) FROM gym_coach_onboarding WHERE device_id=$1 AND created_at_ms >= $2",
      proposed.deviceId, proposed.createdAtMs - proposed.createdAtMs % 86'400'000);
  if (count[0][0].as<long long>() >= 8) return {std::nullopt, false, "request_limit"};
  txn.exec_params("INSERT INTO gym_coach_onboarding "
      "(device_id,request_id,input_hash,result_id,state,created_at_ms,lease_until_ms,expires_at_ms) "
      "VALUES($1,$2,$3,$4,'pending',$5,$6,$7)", proposed.deviceId, proposed.requestId,
      proposed.inputHash, proposed.resultId, proposed.createdAtMs, proposed.leaseUntilMs, proposed.expiresAtMs);
  txn.commit();
  markCurrentWrite();
  return {proposed, true, {}};
}

std::optional<OnboardingRecord> PgOnboardingRepository::get(const std::string& deviceId,
                                                         const std::string& requestId, long long nowMs) {
  PgLease lease{*pool_};
  pqxx::work txn{*lease};
  const auto rows = txn.exec_params("SELECT * FROM gym_coach_onboarding WHERE device_id=$1 AND request_id=$2",
                                   deviceId, requestId);
  if (rows.empty()) return std::nullopt;
  return expireOnboarding(readRecord(rows[0]), nowMs);
}

bool PgOnboardingRepository::finish(const OnboardingRecord& result, long long nowMs) {
  PgLease lease{*pool_};
  pqxx::work txn{*lease};
  const auto rows = txn.exec_params("UPDATE gym_coach_onboarding SET state=$3,payload=$4::jsonb,error_code=$5,terminal_at_ms=$6 "
      "WHERE device_id=$1 AND request_id=$2 AND state='pending' AND lease_until_ms>$6 RETURNING request_id",
      result.deviceId, result.requestId, result.state,
      result.payload.isNull() ? std::optional<std::string>{} : std::optional<std::string>{dump(result.payload)},
      result.errorCode, nowMs);
  txn.commit();
  if (!rows.empty()) markCurrentWrite();
  return !rows.empty();
}

void PgOnboardingRepository::expire(long long nowMs) {
  PgLease lease{*pool_};
  pqxx::work txn{*lease};
  const auto rows = txn.exec_params("UPDATE gym_coach_onboarding SET state=CASE WHEN expires_at_ms<=$1 THEN 'expired' ELSE 'failed' END, "
      "payload=NULL,terminal_at_ms=CASE WHEN terminal_at_ms=0 THEN $1 ELSE terminal_at_ms END,"
      "error_code=CASE WHEN expires_at_ms<=$1 THEN 'result_expired' ELSE 'interrupted' END "
      "WHERE (state='pending' AND lease_until_ms<=$1) OR (state<>'expired' AND expires_at_ms<=$1) RETURNING request_id", nowMs);
  txn.commit();
  if (!rows.empty()) markCurrentWrite();
}

}
