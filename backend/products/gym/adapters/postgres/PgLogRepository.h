#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/LogRepository.h"

#include <memory>
#include <string>

namespace wm::gym {

// The log over Postgres: sessions, their sets, the revisions a correction or a delete leaves
// behind, and the coach share. Idempotent writes by client-minted id, every query scoped to the
// owner. Stateless but for the pool — each method borrows a connection for exactly one transaction
// (platform/adapters/postgres/PgPool.h). The retry story lives in the SQL: insertSession no-ops on
// ANY unique conflict (the PK replay and the one-open partial index both), insertSet locks the
// session row, computes max+1 numbering in the INSERT and reads the stored row back scoped to that
// session, so a replay returns the original byte-for-byte and a spent id resolves to nothing rather
// than to another account's set. updateSet and deleteSet are the two that change a stored set, and
// each writes gym_set_revisions in the SAME statement that moves the row, so there is no instant in
// which a version is gone and unkept. All three writes that change what a workout holds take the
// SESSION's row first and its set rows after — one lock order, which is what makes an append racing
// a delete of the same id decidable and leaves no cycle for two of them to deadlock on. Every pqxx
// error the store has an answer for is translated here into the port's typed facts; the rest ride
// to the house 500.
//
// The port seam is not table ownership: the reads here still join gym_exercises and its per-account
// names (through PgGymRows.h, the one spelling of that join) to print a movement, and insertSet
// checks a movement against the catalog's own predicate before it lands. The tables this file
// WRITES are the log's alone.
class PgLogRepository : public LogRepository {
public:
  explicit PgLogRepository(std::shared_ptr<PgPool> pool);

  std::optional<Session> open(const UserId& user) override;
  std::optional<Session> session(const UserId& user, const SessionId& id) override;
  std::optional<Set> setOf(const UserId& user, const SetId& id) override;
  std::optional<std::uint64_t> lastActivity(const SessionId& id) override;
  void insertSession(const Session& incoming) override;
  void close(const SessionId& id, std::uint64_t finishedAtMs, ClosedBy closedBy) override;
  SetInsertOutcome insertSet(const Set& incoming) override;
  std::optional<Set> updateSet(const UserId& user, const Set& corrected) override;
  void deleteSet(const UserId& user, const SessionId& session, const SetId& id) override;
  LogPage log(const UserId& user, const LogCursor& cursor) override;
  std::vector<Set> setsOf(const SessionId& id) override;
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise) override;
  std::vector<LastSet> lastSets(const UserId& user) override;
  SessionHistory historyFor(const UserId& user, const Session& session) override;
  bool deleteSession(const UserId& user, const SessionId& id) override;
  MovementHistory movementHistory(const UserId& user, const ExerciseId& exercise) override;
  TrainingLog trainingLog(const UserId& user) override;
  std::vector<ExportedSet> exportedSets(const UserId& user) override;
  std::optional<SessionShare> insertShare(const SessionShare& incoming,
                                          std::uint64_t nowMs) override;
  bool revokeShare(const UserId& user, const SessionId& id) override;
  std::optional<SharedSession> sharedSession(const std::string& token,
                                             std::uint64_t nowMs) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
