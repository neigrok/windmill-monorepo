#include "platform/ai_installations/PgAiInstallations.h"

#include "platform/application/WriteObservation.h"

namespace wm {
namespace {

bool admitNetwork(pqxx::work& txn, const AiInstallationNetwork& network, long long atMs) {
  txn.exec("DELETE FROM ai_installation_network_admissions WHERE expires_at_ms <= $1", pqxx::params{atMs});
  txn.exec("DELETE FROM ai_installation_network_limits WHERE expires_at_ms <= $1", pqxx::params{atMs});
  const auto rows = txn.exec("INSERT INTO ai_installation_network_limits (network_digest, expires_at_ms, count) "
      "VALUES ($1, $2, 1) ON CONFLICT (network_digest) DO UPDATE SET count = ai_installation_network_limits.count + 1 "
      "WHERE ai_installation_network_limits.count < $3 RETURNING count",
      pqxx::params{network.digest, network.expiresAtMs, network.limit});
  return !rows.empty();
}

}

std::optional<AiInstallationRow> PgAiInstallations::find(const std::string& tokenDigest) {
  PgLease connection{*pool_};
  pqxx::read_transaction txn{*connection};
  const auto rows = txn.exec("SELECT id, token_digest, created_at_ms FROM ai_installations WHERE token_digest = $1",
                             pqxx::params{tokenDigest});
  if (rows.empty()) return std::nullopt;
  return AiInstallationRow{rows[0][0].as<std::string>(), rows[0][1].as<std::string>(), rows[0][2].as<long long>()};
}

AiInstallationCode PgAiInstallations::issue(const AiInstallationRow& row, const AiInstallationNetwork& network) {
  PgLease connection{*pool_};
  pqxx::work txn{*connection};
  txn.exec("SELECT pg_advisory_xact_lock(1464681031, 2)");
  if (!admitNetwork(txn, network, row.createdAtMs)) return AiInstallationCode::RateLimited;
  txn.exec("INSERT INTO ai_installations (id, token_digest, created_at_ms) VALUES ($1, $2, $3)",
           pqxx::params{row.id, row.tokenDigest, row.createdAtMs});
  txn.commit();
  markCurrentWrite();
  return AiInstallationCode::Ok;
}

AiInstallationCode PgAiInstallations::admit(const std::string& installationId, const std::string& requestId,
                                           const AiInstallationNetwork& network, long long atMs) {
  PgLease connection{*pool_};
  pqxx::work txn{*connection};
  txn.exec("SELECT pg_advisory_xact_lock(1464681031, 2)");
  const auto prior = txn.exec("SELECT 1 FROM ai_installation_network_admissions WHERE installation_id = $1 AND request_id = $2",
                             pqxx::params{installationId, requestId});
  if (!prior.empty()) return AiInstallationCode::Replay;
  if (!admitNetwork(txn, network, atMs)) return AiInstallationCode::RateLimited;
  txn.exec("INSERT INTO ai_installation_network_admissions (installation_id, request_id, expires_at_ms) VALUES ($1, $2, $3)",
           pqxx::params{installationId, requestId, network.expiresAtMs});
  txn.commit();
  markCurrentWrite();
  return AiInstallationCode::Ok;
}

void PgAiInstallations::prune(long long atMs) {
  PgLease connection{*pool_};
  pqxx::work txn{*connection};
  txn.exec("SELECT pg_advisory_xact_lock(1464681031, 2)");
  const auto admissions = txn.exec("DELETE FROM ai_installation_network_admissions WHERE expires_at_ms <= $1", pqxx::params{atMs});
  const auto limits = txn.exec("DELETE FROM ai_installation_network_limits WHERE expires_at_ms <= $1", pqxx::params{atMs});
  txn.commit();
  if (admissions.affected_rows() || limits.affected_rows()) markCurrentWrite();
}

}
