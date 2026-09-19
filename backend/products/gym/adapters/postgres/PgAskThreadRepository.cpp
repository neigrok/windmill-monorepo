#include "products/gym/adapters/postgres/PgAskThreadRepository.h"

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "products/gym/adapters/postgres/PgGymRows.h"

#include <pqxx/pqxx>

#include <optional>
#include <algorithm>
#include <stdexcept>
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

std::vector<ThreadTurn> turnsOf(pqxx::work& txn, const ThreadId& id, std::uint64_t before = 0, int limit = -1, bool context = false) {
  pqxx::result rows = txn.exec_params(
      "SELECT from_lifter, text, receipt::text, position, generation_id, results::text, request_id, status, attachments::text, "
      "(extract(epoch from said_at) * 1000)::bigint AS said_ms "
      "FROM gym_ask_turns WHERE thread_id = $1 AND ($2::bigint = 0 OR position < $2::bigint) "
      "AND (NOT $4::boolean OR status='completed') ORDER BY position DESC LIMIT nullif($3::int, -1)",
      id.str(), static_cast<long long>(before), limit, context);
  std::vector<ThreadTurn> turns;
  for (const auto& row : rows) {
    const bool fromLifter = row["from_lifter"].as<bool>();
    std::optional<AnswerReceipt> receipt;
    if (!fromLifter && !row["receipt"].is_null())
      receipt = receiptFrom(parse(row["receipt"].as<std::string>()));
    turns.push_back(ThreadTurn{fromLifter, row["text"].as<std::string>(),
                               instantFrom(row["said_ms"]), std::move(receipt), row["position"].as<std::uint64_t>(),
                               row["generation_id"].is_null() ? "" : row["generation_id"].as<std::string>()});
    turns.back().requestId = row["request_id"].is_null() ? "" : row["request_id"].as<std::string>();
    turns.back().status = row["status"].as<std::string>();
    if (!row["results"].is_null()) turns.back().results = coachResultsFrom(parse(row["results"].as<std::string>()));
    if (!row["attachments"].is_null()) turns.back().attachments = coachAttachmentsFrom(parse(row["attachments"].as<std::string>()));
  }
  std::reverse(turns.begin(), turns.end());
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
std::optional<AskThread> loadThread(pqxx::work& txn, const UserId& user, const ThreadId& id,
                                   std::uint64_t before = 0, int limit = -1, bool context = false) {
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kThreadColumns) +
          " FROM gym_ask_threads t WHERE t.id = $1 AND t.user_id = $2::uuid",
      id.str(), user.str());
  if (rows.empty()) return std::nullopt;
  AskThread thread = threadFrom(rows[0]);
  thread.turns = turnsOf(txn, id, before, limit < 0 ? -1 : limit + 1, context);
  if (limit >= 0 && thread.turns.size() > static_cast<std::size_t>(limit)) {
    thread.turns.erase(thread.turns.begin());
    thread.nextCursor = std::to_string(thread.turns.front().position);
  }
  const auto generations = txn.exec_params(
      "SELECT payload::text,stop_requested FROM gym_ask_generations WHERE thread_id = $1 AND user_id = $2::uuid "
      "ORDER BY (payload->>'status' = 'running') DESC, created_at DESC, id DESC LIMIT 1", id.str(), user.str());
  if (!generations.empty()) {
    thread.generation = generationFrom(parse(generations[0][0].as<std::string>()));
    thread.generation->stopRequested = generations[0]["stop_requested"].as<bool>();
  }
  const auto receipts = txn.exec_params(
      "SELECT receipt::text FROM gym_ask_turns WHERE thread_id = $1 AND user_id = $2::uuid "
      "AND NOT from_lifter AND receipt IS NOT NULL", id.str(), user.str());
  for (const auto& row : receipts)
    if (const auto receipt = receiptFrom(parse(row[0].as<std::string>())))
      for (const auto& proposal : receipt->proposals) thread.referencedProposals.emplace_back(proposal);
  for (const auto& [from, minted] : mintedIn(txn, user, id.str()))
    thread.minted.push_back(minted);
  const auto actions = txn.exec_params("SELECT (payload->'results')::text AS results FROM gym_ask_generations WHERE thread_id=$1 AND user_id=$2::uuid ORDER BY created_at,id",
                                        id.str(), user.str());
  for (const auto& row : actions) {
    const auto results = coachResultsFrom(parse(row["results"].as<std::string>()));
    thread.results.insert(thread.results.end(), results.begin(), results.end());
  }
  return thread;
}

}

PgAskThreadRepository::PgAskThreadRepository(std::shared_ptr<PgPool> pool)
    : pool_(std::move(pool)) {}

// The turns stay behind: every thread's proposals ride along, newest asked first, kThreadList deep.
std::vector<AskThread> PgAskThreadRepository::threads(const UserId& user) {
  return threadPage(user, ThreadCursor{0, "", kThreadList});
}

std::vector<AskThread> PgAskThreadRepository::threadPage(const UserId& user, const ThreadCursor& cursor) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kThreadColumns) +
          " FROM gym_ask_threads t WHERE t.user_id = $1::uuid"
          " AND ($3::bigint = 0 OR (t.asked_at, t.id) < (to_timestamp($3::bigint / 1000.0), $4))"
          " ORDER BY t.asked_at DESC, t.id DESC LIMIT $2",
      user.str(), cursor.limit, static_cast<long long>(cursor.beforeMs), cursor.beforeId);

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
  if (ids.empty()) return threads;
  const auto actions = txn.exec_params("SELECT thread_id,(payload->'results')::text AS results FROM gym_ask_generations WHERE user_id=$1::uuid AND thread_id=ANY(string_to_array($2, ',')) ORDER BY created_at,id",
                                       user.str(), ids);
  for (const auto& row : actions)
    for (auto& thread : threads)
      if (thread.id.str() == row["thread_id"].as<std::string>()) {
        const auto results = coachResultsFrom(parse(row["results"].as<std::string>()));
        thread.results.insert(thread.results.end(), results.begin(), results.end());
      }
  // Validate the complete stored receipt before its ids can influence an outcome. Turn prose stays behind.
  const pqxx::result receipts = txn.exec_params(
      "SELECT thread_id, receipt::text FROM gym_ask_turns "
      "WHERE user_id = $1::uuid AND thread_id = ANY(string_to_array($2, ',')) "
      "AND NOT from_lifter AND receipt IS NOT NULL ORDER BY thread_id, position",
      user.str(), ids);
  for (const auto& row : receipts) {
    const auto receipt = receiptFrom(parse(row["receipt"].as<std::string>()));
    if (!receipt) continue;
    for (AskThread& thread : threads)
      if (thread.id.str() == row["thread_id"].as<std::string>())
        for (const std::string& proposal : receipt->proposals)
          thread.referencedProposals.emplace_back(proposal);
  }
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

bool PgAskThreadRepository::threadAvailable(const UserId& user, const ThreadId& id) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  return txn.exec_params("SELECT NOT EXISTS(SELECT 1 FROM gym_ask_deleted_threads WHERE id=$1) "
                         "AND NOT EXISTS(SELECT 1 FROM gym_ask_threads WHERE id=$1 AND user_id<>$2::uuid)",
                         id.str(), user.str())[0][0].as<bool>();
}

ThreadOpenOutcome PgAskThreadRepository::openThread(const UserId& user, const ThreadId& id,
                                                   const std::string& title, std::uint64_t nowMs) {
  // The id is asked globally and the conversation read under the owner: the primary key spans every
  // account, so an id somebody else holds is refused rather than appended to.
  // Proposals and durable generations reference this row before the model runs.
  std::optional<AskThread> opened;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    if (!txn.exec_params("SELECT 1 FROM gym_ask_deleted_threads WHERE id=$1", id.str()).empty())
      return {std::nullopt, ThreadOpenError::idTaken};
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
    opened = loadThread(txn, user, id, 0, kMaxContextTurns, true);
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
  for (const ThreadTurn& turn : turns) {
    const std::optional<std::string> receipt = !turn.fromLifter && turn.receipt
        ? std::optional<std::string>{dump(toJson(*turn.receipt))} : std::nullopt;
    txn.exec_params(
        "INSERT INTO gym_ask_turns (thread_id, position, user_id, from_lifter, text, said_at, receipt) "
        "SELECT $1, coalesce(max(position), 0) + 1, $2::uuid, $3, $4, "
        "       to_timestamp($5::bigint / 1000.0), $6::jsonb "
        "FROM gym_ask_turns WHERE thread_id = $1",
        id.str(), user.str(), turn.fromLifter, turn.text,
        static_cast<long long>(turn.atMs), receipt);
  }
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
                  "  AND NOT EXISTS (SELECT 1 FROM gym_ask_turns WHERE thread_id = $1)"
                  "  AND NOT EXISTS (SELECT 1 FROM gym_ask_generations WHERE thread_id = $1)",
                  id.str(), user.str());
  txn.commit();
}

bool PgAskThreadRepository::deleteThread(const UserId& user, const ThreadId& id) {
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    if (txn.exec_params("SELECT 1 FROM gym_ask_threads WHERE id=$1 AND user_id=$2::uuid", id.str(), user.str()).empty()) return false;
  }
  auto lease = tryLease(user, id);
  if (!lease) throw ThreadBusy{};
  // The turns cascade with the row; the proposals do not — the schema sets their thread_id null.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result removed = txn.exec_params(
      "DELETE FROM gym_ask_threads WHERE id = $1 AND user_id = $2::uuid RETURNING id", id.str(),
      user.str());
  if (!removed.empty()) txn.exec_params("INSERT INTO gym_ask_deleted_threads(id,user_id) VALUES($1,$2::uuid) ON CONFLICT DO NOTHING", id.str(), user.str());
  txn.commit();
  return !removed.empty();
}

std::optional<AskThread> PgAskThreadRepository::messagePage(const UserId& user, const ThreadId& id,
                                                          std::uint64_t before, int limit) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  return loadThread(txn, user, id, before, limit);
}

namespace {
class PgThreadLease final : public ThreadLease {
public:
  PgThreadLease(PgPool& pool, std::string key) : conn_(pool), key_(std::move(key)) {
    pqxx::work txn{*conn_};
    acquired = txn.exec_params("SELECT pg_try_advisory_lock(hashtextextended($1, 0))", key_)[0][0].as<bool>();
    txn.commit();
  }
  ~PgThreadLease() override {
    if (!acquired) return;
    try {
      pqxx::work txn{*conn_};
      txn.exec_params("SELECT pg_advisory_unlock(hashtextextended($1, 0))", key_);
      txn.commit();
    } catch (...) { conn_->close(); }
  }
  bool acquired = false;
private:
  PgLease conn_;
  std::string key_;
};
}

std::unique_ptr<ThreadLease> PgAskThreadRepository::tryLease(const UserId&, const ThreadId& id) {
  auto lease = std::make_unique<PgThreadLease>(*pool_, "gym-ask:" + id.str());
  if (!lease->acquired) return nullptr;
  return lease;
}

std::optional<AskGeneration> PgAskThreadRepository::generation(const UserId& user, const ThreadId& thread,
                                                              const std::string& requestId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params(
      "SELECT payload::text,stop_requested FROM gym_ask_generations WHERE user_id = $1::uuid AND thread_id = $2 AND request_id = $3",
      user.str(), thread.str(), requestId);
  if (rows.empty()) return std::nullopt;
  auto result = generationFrom(parse(rows[0][0].as<std::string>()));
  result.stopRequested = rows[0]["stop_requested"].as<bool>();
  return result;
}

void PgAskThreadRepository::saveGeneration(const UserId& user, const ThreadId& thread,
                                            AskGeneration& generation) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  if (txn.exec_params("SELECT 1 FROM gym_ask_threads WHERE id = $1 AND user_id = $2::uuid FOR UPDATE",
                       thread.str(), user.str()).empty()) throw std::runtime_error("conversation absent");
  const auto prior = txn.exec_params(
      "SELECT payload::text FROM gym_ask_generations WHERE user_id = $1::uuid AND thread_id = $2 AND request_id = $3",
      user.str(), thread.str(), generation.requestId);
  if (!prior.empty()) {
    const auto stored = generationFrom(parse(prior[0][0].as<std::string>()));
    if (stored.status == "completed" || stored.status == "stopped") { generation = stored; return; }
    generation.revision = stored.revision;
  }
  ++generation.revision;
  for (const auto& attachment : generation.attachments)
    if (txn.exec_params("UPDATE gym_ask_attachments SET linked_thread_id=$1 WHERE id=$2 AND user_id=$3::uuid AND thread_id=$1 RETURNING id",
                         thread.str(), attachment.id, user.str()).empty()) throw std::runtime_error("picture absent");
  txn.exec_params(
      "INSERT INTO gym_ask_generations(id,thread_id,user_id,request_id,payload) VALUES ($1,$2,$3::uuid,$4,$5::jsonb) "
      "ON CONFLICT (thread_id,request_id) DO UPDATE SET payload = excluded.payload "
      "WHERE gym_ask_generations.user_id = excluded.user_id AND gym_ask_generations.id = excluded.id",
      generation.id, thread.str(), user.str(), generation.requestId, dump(toJson(generation)));
  if (generation.status != "running") {
    const auto receipt = generation.receipt ? std::optional<std::string>{dump(toJson(*generation.receipt))} : std::nullopt;
    const std::string results = dump(toJson(generation.results));
    Json::Value attachments(Json::arrayValue);
    for (const auto& attachment : generation.attachments) attachments.append(toJson(attachment));
    const auto held = txn.exec_params("SELECT position FROM gym_ask_turns WHERE thread_id=$1 AND user_id=$2::uuid AND generation_id=$3 ORDER BY position",
                                       thread.str(), user.str(), generation.id);
    for (bool lifter : {true, false}) {
      if (!held.empty()) {
        txn.exec_params("UPDATE gym_ask_turns SET text=$4,receipt=$5::jsonb,results=$6::jsonb,status=$7 "
                         "WHERE thread_id=$1 AND user_id=$2::uuid AND generation_id=$3 AND from_lifter=$8",
                         thread.str(), user.str(), generation.id, lifter ? generation.question : generation.answer,
                         lifter ? std::nullopt : receipt, lifter ? "[]" : results, generation.status, lifter);
        continue;
      }
      txn.exec_params(
          "INSERT INTO gym_ask_turns(thread_id,position,user_id,from_lifter,text,said_at,receipt,generation_id,results,request_id,status,attachments) "
          "SELECT $1,coalesce(max(position),0)+1,$2::uuid,$3,$4,to_timestamp($5::bigint/1000.0),$6::jsonb,$7,$8::jsonb,$9,$10,$11::jsonb "
          "FROM gym_ask_turns WHERE thread_id=$1", thread.str(), user.str(), lifter,
          lifter ? generation.question : generation.answer, static_cast<long long>(generation.atMs),
          lifter ? std::nullopt : receipt, generation.id, lifter ? "[]" : results, generation.requestId, generation.status, lifter ? dump(attachments) : "[]");
    }
  }
  txn.exec_params("UPDATE gym_ask_threads SET asked_at=greatest(asked_at,to_timestamp($2::bigint/1000.0)) WHERE id=$1",
                   thread.str(), static_cast<long long>(generation.atMs));
  txn.commit();
}

std::optional<CoachOperation> PgAskThreadRepository::operation(const UserId& user, const ThreadId& thread,
                                                              const std::string& generationId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params(
      "SELECT operation::text FROM gym_ask_generations WHERE id=$1 AND user_id=$2::uuid AND thread_id=$3",
      generationId, user.str(), thread.str());
  if (rows.empty() || rows[0][0].is_null()) return std::nullopt;
  const auto body = parse(rows[0][0].as<std::string>());
  CoachOperation operation{body["id"].asString(), body["name"].asString(), body["arguments"]};
  if (body.isMember("result")) {
    ToolResult result;
    result.content = body["result"]["content"];
    result.payload = body["result"]["payload"];
    result.structured = body["result"]["structured"];
    result.isError = body["result"]["isError"].asBool();
    operation.result = result;
  }
  return operation;
}

void PgAskThreadRepository::saveOperation(const UserId& user, const ThreadId& thread,
                                           const std::string& generationId, const CoachOperation& operation) {
  Json::Value body(Json::objectValue);
  body["id"] = operation.id;
  body["name"] = operation.name;
  body["arguments"] = operation.arguments;
  if (operation.result) {
    body["result"]["content"] = operation.result->content;
    body["result"]["payload"] = operation.result->payload;
    body["result"]["structured"] = operation.result->structured;
    body["result"]["isError"] = operation.result->isError;
  }
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params(
      "UPDATE gym_ask_generations SET operation=$4::jsonb WHERE id=$1 AND user_id=$2::uuid AND thread_id=$3 RETURNING id",
      generationId, user.str(), thread.str(), dump(body));
  if (rows.empty()) throw std::runtime_error("conversation generation absent");
  txn.commit();
}

std::optional<AskGeneration> PgAskThreadRepository::stopGeneration(const UserId& user, const ThreadId& thread,
                                                                   const std::string& requestId) {
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    txn.exec_params("UPDATE gym_ask_generations SET stop_requested=true WHERE user_id=$1::uuid AND thread_id=$2 AND request_id=$3 AND payload->>'status'='running'",
                    user.str(), thread.str(), requestId);
    txn.commit();
  }
  return generation(user, thread, requestId);
}

std::optional<CoachImage> PgAskThreadRepository::image(const UserId& user, const ThreadId& thread, const std::string& id) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  const auto rows = txn.exec_params("SELECT media_type,width,height,data FROM gym_ask_attachments WHERE id=$1 AND user_id=$2::uuid AND thread_id=$3 AND (linked_thread_id IS NOT NULL OR created_at > now() - interval '24 hours')",
                                    id, user.str(), thread.str());
  if (rows.empty()) return std::nullopt;
  const auto bytes = rows[0]["data"].as<pqxx::bytes>();
  return CoachImage{{id, rows[0]["media_type"].as<std::string>(), rows[0]["width"].as<int>(), rows[0]["height"].as<int>(), bytes.size()},
                    std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())};
}

ImageWriteError PgAskThreadRepository::putImage(const UserId& user, const ThreadId& thread, const CoachImage& image) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec("DELETE FROM gym_ask_attachments WHERE linked_thread_id IS NULL AND created_at < now() - interval '24 hours'");
  if (!txn.exec_params("SELECT 1 FROM gym_ask_deleted_threads WHERE id=$1", thread.str()).empty()) return ImageWriteError::notFound;
  const auto owner = txn.exec_params("SELECT 1 FROM gym_ask_threads WHERE id=$1 AND user_id<>$2::uuid", thread.str(), user.str());
  if (!owner.empty()) return ImageWriteError::notFound;
  const auto existing = txn.exec_params("SELECT user_id=$2::uuid AND thread_id=$3 AND data=$4 AS same FROM gym_ask_attachments WHERE id=$1",
                                        image.attachment.id, user.str(), thread.str(), pqxx::binary_cast(image.data));
  if (!existing.empty()) return existing[0]["same"].as<bool>() ? ImageWriteError::none : ImageWriteError::idTaken;
  txn.exec_params("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "gym-images:" + user.str());
  if (txn.exec_params("SELECT count(*) FROM gym_ask_attachments WHERE user_id=$1::uuid AND created_at>now()-interval '24 hours'", user.str())[0][0].as<int>() >= 30)
    return ImageWriteError::dailyLimit;
  const auto inserted = txn.exec_params("INSERT INTO gym_ask_attachments(id,user_id,thread_id,media_type,width,height,data) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id",
                                        image.attachment.id, user.str(), thread.str(), image.attachment.mediaType, image.attachment.width, image.attachment.height, pqxx::binary_cast(image.data));
  if (inserted.empty()) {
    const auto held = txn.exec_params("SELECT user_id=$2::uuid AND thread_id=$3 AND data=$4 AS same FROM gym_ask_attachments WHERE id=$1",
                                      image.attachment.id, user.str(), thread.str(), pqxx::binary_cast(image.data));
    if (held.empty() || !held[0][0].as<bool>()) return ImageWriteError::idTaken;
  }
  txn.commit();
  return ImageWriteError::none;
}

}
