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

int PgEventRepository::countInLastDay(const std::string& sessionKey) {
  // An index range scan over one session (events_session_ts), never a scan of the stream: this
  // runs on the anonymous intake path, once per batch.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  return txn.exec_params("SELECT count(*)::int FROM events WHERE session_key = $1 "
                         "AND ts > now() - interval '1 day'",
                         sessionKey)[0][0].as<int>();
}

std::optional<ServerEvent> PgEventRepository::recordOnce(pqxx::work& txn, const ServerEvent& event) {
  // The key first: one already recorded inserts no key, and so no row. KEY SHARE holds the attributed account until the
  // commit, so an erasure waits for the row and then deletes it with the rest of the account's events.
  const std::optional<std::string> user = event.user ? std::optional<std::string>{event.user->str()} : std::nullopt;
  const pqxx::result stored = txn.exec(
      "WITH recorded AS (INSERT INTO server_event_keys (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key), "
      "held AS (SELECT id FROM users WHERE id = $4::uuid FOR KEY SHARE) "
      "INSERT INTO events (client_ms, session_key, user_id, name, props, server_key) "
      "SELECT $2, CASE WHEN held.id IS NULL THEN $3 END, held.id, $5, $6::jsonb, recorded.key "
      "FROM recorded LEFT JOIN held ON true "
      "RETURNING coalesce(session_key, ''), user_id::text",
      pqxx::params{event.event.id, event.event.clientMs, event.sessionKey, user, event.event.name, event.event.props});
  if (stored.empty()) return std::nullopt;
  ServerEvent recorded = event;
  recorded.sessionKey = stored[0][0].as<std::string>();
  recorded.user = stored[0][1].is_null() ? std::nullopt : std::optional<UserId>{UserId{stored[0][1].as<std::string>()}};
  return recorded;
}

}
