#include "platform/adapters/postgres/PgEventRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

namespace wm {

PgEventRepository::PgEventRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

void PgEventRepository::append(const std::string& sessionKey, const std::optional<UserId>& user,
                               const std::vector<FunnelEvent>& events) {
  if (events.empty()) return;

  // One multi-row INSERT in one txn: the whole batch lands together or not at all.
  std::string sql = "INSERT INTO events (client_ms, session_key, user_id, name, props) VALUES ";
  pqxx::params params;
  int next = 1;
  for (const FunnelEvent& event : events) {
    if (next > 1) sql += ", ";
    sql += "($" + std::to_string(next) + ", $" + std::to_string(next + 1) + ", $" +
           std::to_string(next + 2) + "::uuid, $" + std::to_string(next + 3) + ", $" +
           std::to_string(next + 4) + "::jsonb)";
    next += 5;
    params.append(event.clientMs);
    params.append(sessionKey);
    if (user) params.append(user->str());
    else params.append();
    params.append(event.name);
    params.append(event.props);
  }

  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec(sql, params);
  txn.commit();
}

}
