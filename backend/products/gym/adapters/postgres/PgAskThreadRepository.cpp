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

// The proposals a set of conversations minted, each paired with the thread it came from, projected
// to what an outcome is made of — the routine's NAME being the one thing a proposal row does not
// carry and the one thing the outcome says out loud. It joins the routine as it stands TODAY rather
// than the base name frozen at the mint, because the row points at a day of the program a lifter can
// open, and a routine renamed since must be findable under the name it now has.
//
// The ids travel as one comma-joined string through `string_to_array` rather than as an array
// parameter: pqxx's array binding is one of the names that differ between the macOS build and the
// CI's Linux one, and no id can hold a comma (the id-shape rule takes letters, digits, `_` and `-`
// and nothing else).
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

// The conversation, read inside a caller's transaction and scoped to the owner — absent and another
// account's are one answer here, exactly as they are on every other read in this module.
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

// TWO STATEMENTS AND NOT ONE PER ROW: the outcome of every row is derived from that row's proposals,
// so a read that asked per thread would be the N+1 the log read already refused. The turns stay
// behind in both readings — the list draws titles, and the export loads its turns separately.
//
// The `order` and the `limit` are the whole of what the two callers differ by, and they differ for a
// reason each: the LIST is newest first and stops at kThreadList because that is a screen; the
// EXPORT is oldest first and stops nowhere because that is an archive.
std::vector<AskThread> threadsUnder(pqxx::work& txn, const UserId& user, std::string_view order,
                                    std::optional<int> limit) {
  pqxx::result rows =
      limit ? txn.exec_params("SELECT " + std::string(kThreadColumns) +
                                  " FROM gym_ask_threads t WHERE t.user_id = $1::uuid ORDER BY " +
                                  std::string(order) + " LIMIT $2",
                              user.str(), *limit)
            : txn.exec_params("SELECT " + std::string(kThreadColumns) +
                                  " FROM gym_ask_threads t WHERE t.user_id = $1::uuid ORDER BY " +
                                  std::string(order),
                              user.str());

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
}

PgAskThreadRepository::PgAskThreadRepository(std::shared_ptr<PgPool> pool)
    : pool_(std::move(pool)) {}

std::vector<AskThread> PgAskThreadRepository::threads(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  return threadsUnder(txn, user, "t.asked_at DESC, t.id DESC", kThreadList);
}

std::vector<AskThread> PgAskThreadRepository::allThreads(const UserId& user) {
  // No ceiling, on purpose: this is what the export's outcomes are stamped from, and an export that
  // omitted the 201st conversation's outcome would be the route's own comment made false. It is
  // ordered like the turns beside it, so the two halves of one file are read in one order.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  return threadsUnder(txn, user, "t.created_at, t.id", std::nullopt);
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
  // THE ID IS ASKED GLOBALLY AND THE CONVERSATION IS READ UNDER THE OWNER, and the split is the
  // point: the primary key spans every account, so an id somebody else holds must be refused rather
  // than read as free and appended to. It is the same two-step `spentId` takes for a proposal, and
  // it is asked here — before the model runs — so a refusal costs nobody a vendor token.
  //
  // The insert lands BEFORE the answer because a proposal minted mid-conversation references this
  // row. A run that then never answers is undone by `discardEmptyThread`, which is what keeps a
  // question nobody answered out of the list.
  std::optional<AskThread> opened;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result held = txn.exec_params(
        "SELECT (user_id = $2::uuid) AS mine FROM gym_ask_threads WHERE id = $1", id.str(),
        user.str());
    if (!held.empty() && !held[0]["mine"].as<bool>())
      return {std::nullopt, ThreadOpenError::idTaken};
    // The title is written ONCE, on the row that opens the thread: a thread is named by how it
    // opened, so a later ask into the same conversation cannot rewrite what it is about.
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
  // instead of racing for the same number — the parent-first lock order every gym write keeps, here
  // the thread row before its turns.
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
  // Only while it holds no turns, which is the whole of the guard: a follow-up ask that failed must
  // not take a conversation that already happened with it.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM gym_ask_threads WHERE id = $1 AND user_id = $2::uuid "
                  "  AND NOT EXISTS (SELECT 1 FROM gym_ask_turns WHERE thread_id = $1)",
                  id.str(), user.str());
  txn.commit();
}

bool PgAskThreadRepository::deleteThread(const UserId& user, const ThreadId& id) {
  // THE CONVERSATION GOES AND THE CONSEQUENCE STAYS (§O). The turns cascade with the row; the
  // proposals do NOT — the schema sets their thread_id null — so an applied change is still in the
  // routine's history, still saying it came from Ask, and simply no longer opens a conversation that
  // exists. That is not leniency: an applied change is a fact about somebody's program rather than a
  // message, and deleting the message must not rewrite the program's past.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result removed = txn.exec_params(
      "DELETE FROM gym_ask_threads WHERE id = $1 AND user_id = $2::uuid RETURNING id", id.str(),
      user.str());
  txn.commit();
  return !removed.empty();
}

std::vector<ExportedThreadTurn> PgAskThreadRepository::exportedThreadTurns(const UserId& user) {
  // Every value TEXT and every rendering Postgres's, exactly as the sets export is: the instants
  // ISO-8601 UTC, the numbers at their own scale, and the turn itself byte for byte. The outcome
  // columns come back EMPTY on purpose — that ladder is the domain's (domain/Thread.h) and
  // LogService stamps it on, because a CASE expression here would be a second copy of a rule in a
  // language the domain cannot read.
  //
  // Ordered by the thread's own (created_at, id) and then by the turns inside it: the order the
  // conversations were had, and the same unique pair every other read here orders on.
  //
  // A LEFT JOIN, AND THE THREE COLUMNS COALESCED, because a thread with no turns is real: the row is
  // committed before the model runs, so one exists throughout every in-flight ask and forever if the
  // process died before the answer. It is listed on screen and it is the lifter's to delete, so an
  // INNER JOIN made the export quietly smaller than the list under a route promising nothing
  // omitted. Such a thread exports as itself with the turn columns empty.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT t.id AS thread_id, t.title, "
      "       to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') "
      "         AS created_at, "
      "       coalesce(n.position::text, '') AS turn_number, "
      // `n.from_lifter IS NULL` is asked FIRST and not folded into a coalesce: a plain CASE sends a
      // NULL down the ELSE branch, so an absent turn would have exported as one Ask had said.
      "       CASE WHEN n.from_lifter IS NULL THEN '' "
      "            WHEN n.from_lifter THEN 'lifter' ELSE 'ask' END AS turn_from, "
      "       coalesce(n.text, '') AS text, "
      "       coalesce(to_char(n.said_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '') "
      "         AS said_at "
      "FROM gym_ask_threads t "
      "     LEFT JOIN gym_ask_turns n ON n.thread_id = t.id AND n.user_id = $1::uuid "
      "WHERE t.user_id = $1::uuid "
      "ORDER BY t.created_at, t.id, n.position",
      user.str());

  std::vector<ExportedThreadTurn> turns;
  for (const auto& row : rows)
    turns.push_back(ExportedThreadTurn{row["thread_id"].as<std::string>(),
                                       row["title"].as<std::string>(),
                                       "",
                                       "",
                                       "",
                                       row["created_at"].as<std::string>(),
                                       row["turn_number"].as<std::string>(),
                                       row["turn_from"].as<std::string>(),
                                       row["text"].as<std::string>(),
                                       row["said_at"].as<std::string>()});
  return turns;
}

}
