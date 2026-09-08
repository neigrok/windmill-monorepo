#include "products/gym/adapters/postgres/PgAskThreadRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/postgres/PgGymRows.h"

#include <pqxx/pqxx>

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {
constexpr std::string_view kThreadColumns =
    "t.id, t.user_id, t.title, "
    "(extract(epoch from t.created_at) * 1000)::bigint AS created_ms, "
    "(extract(epoch from t.asked_at) * 1000)::bigint AS asked_ms";

// Joins the routine as it stands today, not the base name frozen at the mint. The ids travel as one
// comma-joined string through `string_to_array` rather than an array parameter: pqxx's array binding
// differs between the macOS and CI Linux builds, and the id-shape rule allows no comma.
std::vector<std::pair<std::string, ThreadProposal>> mintedIn(pqxx::work& txn, const UserId& user,
                                                             const std::string& threads) {
  std::vector<std::pair<std::string, ThreadProposal>> minted;
  if (threads.empty()) return minted;
  pqxx::result rows = txn.exec_params(
      "SELECT p.id, p.thread_id, p.state, p.changes, p.routine_id, r.name AS routine_name, "
      "       (extract(epoch from p.created_at) * 1000)::bigint AS created_ms "
      "FROM gym_proposals p JOIN gym_routines r ON r.id = p.routine_id "
      "WHERE p.user_id = $1::uuid AND p.thread_id = ANY(string_to_array($2, ',')) "
      "ORDER BY p.created_at, p.id",
      user.str(), threads);
  for (const auto& row : rows)
    minted.emplace_back(row["thread_id"].as<std::string>(),
                        ThreadProposal{ProposalId{row["id"].as<std::string>()},
                                       proposalStateFromStored(row["state"].as<std::string>()),
                                       row["changes"].as<int>(),
                                       RoutineId{row["routine_id"].as<std::string>()},
                                       row["routine_name"].as<std::string>(),
                                       instantFrom(row["created_ms"])});
  return minted;
}

std::vector<ThreadTurn> turnsOf(pqxx::work& txn, const ThreadId& id) {
  pqxx::result rows = txn.exec_params(
      "SELECT from_lifter, text, (extract(epoch from said_at) * 1000)::bigint AS said_ms "
      "FROM gym_ask_turns WHERE thread_id = $1 ORDER BY position",
      id.str());
  std::vector<ThreadTurn> turns;
  for (const auto& row : rows)
    turns.push_back(ThreadTurn{row["from_lifter"].as<bool>(), row["text"].as<std::string>(),
                               instantFrom(row["said_ms"])});
  return turns;
}

template <typename Row>
AskThread threadFrom(const Row& row) {
  return AskThread{ThreadId{row["id"].template as<std::string>()},
                   UserId{row["user_id"].template as<std::string>()},
                   row["title"].template as<std::string>(),
                   instantFrom(row["created_ms"]),
                   instantFrom(row["asked_ms"]),
                   {},
                   {}};
}

// Scoped to the owner: absent and another account's are one answer.
std::optional<AskThread> loadThread(pqxx::work& txn, const UserId& user, const ThreadId& id) {
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kThreadColumns) +
          " FROM gym_ask_threads t WHERE t.id = $1 AND t.user_id = $2::uuid",
      id.str(), user.str());
  if (rows.empty()) return std::nullopt;
  AskThread thread = threadFrom(rows[0]);
  thread.turns = turnsOf(txn, id);
  for (const auto& [from, minted] : mintedIn(txn, user, id.str()))
    thread.minted.push_back(minted);
  return thread;
}

}

PgAskThreadRepository::PgAskThreadRepository(std::shared_ptr<PgPool> pool)
    : pool_(std::move(pool)) {}

// The turns stay behind: every thread's proposals ride along, newest asked first, kThreadList deep.
std::vector<AskThread> PgAskThreadRepository::threads(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kThreadColumns) +
          " FROM gym_ask_threads t WHERE t.user_id = $1::uuid"
          " ORDER BY t.asked_at DESC, t.id DESC LIMIT $2",
      user.str(), kThreadList);

  std::vector<AskThread> threads;
  std::string ids;
  for (const auto& row : rows) {
    threads.push_back(threadFrom(row));
    if (!ids.empty()) ids += ',';
    ids += threads.back().id.str();
  }
  for (const auto& [from, minted] : mintedIn(txn, user, ids))
    for (AskThread& thread : threads)
      if (thread.id.str() == from) thread.minted.push_back(minted);
  return threads;
}

std::optional<AskThread> PgAskThreadRepository::thread(const UserId& user, const ThreadId& id) {
  std::optional<AskThread> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    found = loadThread(txn, user, id);
  }
  return found;
}

ThreadOpenOutcome PgAskThreadRepository::openThread(const UserId& user, const ThreadId& id,
                                                   const std::string& title, std::uint64_t nowMs) {
  // The id is asked globally and the conversation read under the owner: the primary key spans every
  // account, so an id somebody else holds is refused rather than appended to.
  // The insert lands before the answer because a proposal minted mid-conversation references this
  // row; a run that never answers is undone by `discardEmptyThread`.
  std::optional<AskThread> opened;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result held = txn.exec_params(
        "SELECT (user_id = $2::uuid) AS mine FROM gym_ask_threads WHERE id = $1", id.str(),
        user.str());
    if (!held.empty() && !held[0]["mine"].as<bool>())
      return {std::nullopt, ThreadOpenError::idTaken};
    // The title is written once, on the row that opens the thread.
    txn.exec_params("INSERT INTO gym_ask_threads (id, user_id, title, created_at, asked_at) "
                    "VALUES ($1, $2::uuid, $3, to_timestamp($4::bigint / 1000.0), "
                    "        to_timestamp($4::bigint / 1000.0)) ON CONFLICT (id) DO NOTHING",
                    id.str(), user.str(), title, static_cast<long long>(nowMs));
    opened = loadThread(txn, user, id);
    txn.commit();
  }
  return {opened, ThreadOpenError::none};
}

void PgAskThreadRepository::appendTurns(const UserId& user, const ThreadId& id,
                                       const std::vector<ThreadTurn>& turns) {
  // The position is assigned under the thread's own lock, so two asks into one conversation queue
  // instead of racing for the same number. Parent first: the thread row before its turns.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result locked = txn.exec_params(
      "SELECT 1 FROM gym_ask_threads WHERE id = $1 AND user_id = $2::uuid FOR UPDATE", id.str(),
      user.str());
  if (locked.empty()) return;
  for (const ThreadTurn& turn : turns)
    txn.exec_params(
        "INSERT INTO gym_ask_turns (thread_id, position, user_id, from_lifter, text, said_at) "
        "SELECT $1, coalesce(max(position), 0) + 1, $2::uuid, $3, $4, "
        "       to_timestamp($5::bigint / 1000.0) "
        "FROM gym_ask_turns WHERE thread_id = $1",
        id.str(), user.str(), turn.fromLifter, turn.text,
        static_cast<long long>(turn.atMs));
  txn.exec_params("UPDATE gym_ask_threads SET asked_at = to_timestamp($2::bigint / 1000.0) "
                  "WHERE id = $1",
                  id.str(), static_cast<long long>(turns.empty() ? 0 : turns.back().atMs));
  txn.commit();
}

void PgAskThreadRepository::discardEmptyThread(const UserId& user, const ThreadId& id) {
  // Only while it holds no turns.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM gym_ask_threads WHERE id = $1 AND user_id = $2::uuid "
                  "  AND NOT EXISTS (SELECT 1 FROM gym_ask_turns WHERE thread_id = $1)",
                  id.str(), user.str());
  txn.commit();
}

bool PgAskThreadRepository::deleteThread(const UserId& user, const ThreadId& id) {
  // The turns cascade with the row; the proposals do not — the schema sets their thread_id null.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result removed = txn.exec_params(
      "DELETE FROM gym_ask_threads WHERE id = $1 AND user_id = $2::uuid RETURNING id", id.str(),
      user.str());
  txn.commit();
  return !removed.empty();
}

}
