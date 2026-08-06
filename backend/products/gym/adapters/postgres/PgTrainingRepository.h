#pragma once

#include "products/gym/ports/TrainingRepository.h"

#include <string>

namespace wm::gym {

// Gym storage over Postgres: idempotent writes by client-minted id, every query scoped to the
// owner. Stateless but for the connection string — each method opens a pqxx::work on the
// thread-local connection (platform/adapters/postgres/PgConnection.h). The retry story lives in
// the SQL: insertSession no-ops on ANY unique conflict (the PK replay and the one-open partial
// index both), insertSet locks the session row, computes max+1 numbering in the INSERT and reads
// the stored row back scoped to that session, so a replay returns the original byte-for-byte and
// a spent id resolves to nothing rather than to another account's set. insertRoutine is the same
// story over two tables in one transaction, and insertExercise over one. Every pqxx error the store
// has an answer for is translated here into the port's typed facts; the rest ride to the house 500.
class PgTrainingRepository : public TrainingRepository {
public:
  explicit PgTrainingRepository(std::string connString);

  std::vector<Exercise> catalog(const UserId& user) override;
  std::optional<Session> open(const UserId& user) override;
  std::optional<Session> session(const UserId& user, const SessionId& id) override;
  std::optional<Set> setOf(const UserId& user, const SetId& id) override;
  std::optional<std::uint64_t> lastActivity(const SessionId& id) override;
  void insertSession(const Session& incoming) override;
  void close(const SessionId& id, std::uint64_t finishedAtMs) override;
  SetInsertOutcome insertSet(const Set& incoming) override;
  std::vector<SessionSummary> log(const UserId& user, const LogCursor& cursor) override;
  std::vector<Set> setsOf(const SessionId& id) override;
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise) override;
  SessionHistory historyFor(const UserId& user, const Session& session) override;
  bool deleteSession(const UserId& user, const SessionId& id) override;
  std::vector<Routine> routines(const UserId& user) override;
  std::optional<Routine> routine(const UserId& user, const RoutineId& id) override;
  RoutineWriteOutcome insertRoutine(const Routine& incoming) override;
  RoutineWriteOutcome replaceRoutine(const Routine& incoming) override;
  bool deleteRoutine(const UserId& user, const RoutineId& id) override;
  ExerciseInsertOutcome insertExercise(const UserId& owner, const Exercise& incoming) override;
  TrainingLog trainingLog(const UserId& user) override;
  std::vector<ExportedSet> exportedSets(const UserId& user) override;
  std::optional<SessionShare> insertShare(const SessionShare& incoming,
                                          std::uint64_t nowMs) override;
  bool revokeShare(const UserId& user, const SessionId& id) override;
  std::optional<SharedSession> sharedSession(const std::string& token,
                                             std::uint64_t nowMs) override;

private:
  std::string connString_;
};

}
