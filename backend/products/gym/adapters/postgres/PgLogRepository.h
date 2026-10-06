#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/gym/ports/LogRepository.h"

#include <memory>
#include <string>

namespace wm::gym {

// Sessions, their sets, the revisions a correction or a delete leaves behind, and the two shares.
// Every query is scoped to the owner, and each method borrows a connection for exactly one
// transaction.
class PgLogRepository : public LogRepository {
public:
  explicit PgLogRepository(std::shared_ptr<PgPool> pool);

  std::optional<Session> open(const UserId& user) override;
  std::optional<Session> session(const UserId& user, const SessionId& id) override;
  std::optional<Set> setOf(const UserId& user, const SetId& id) override;
  std::vector<SessionRows> sessions(const UserId& user, const std::vector<SessionId>& ids) override;
  HistoryPage history(const UserId& user, const HistoryQuery& query) override;
  std::optional<LogShare> createLogShare(const LogShare& share) override;
  std::vector<LogShare> logShares(const UserId& user, std::uint64_t nowMs) override;
  void revokeLogShare(const UserId& user, const std::string& id) override;
  std::optional<SharedHistory> sharedHistory(const std::string& token,
      const HistoryQuery& query, std::uint64_t nowMs) override;
  LogPage log(const UserId& user, const LogCursor& cursor) override;
  std::vector<Set> setsOf(const SessionId& id) override;
  LastTimeOutcome lastTime(const UserId& user, const ExerciseId& exercise) override;
  std::vector<LastSet> lastSets(const UserId& user) override;
  SessionHistory historyFor(const UserId& user, const Session& session) override;
  MovementHistory movementHistory(const UserId& user, const ExerciseId& exercise) override;
  TrainingLog trainingLog(const UserId& user) override;
  std::vector<ProgressSet> progressHistory(const UserId& user) override;
  std::optional<SessionShare> insertShare(const SessionShare& incoming,
                                          std::uint64_t nowMs) override;
  bool revokeShare(const UserId& user, const SessionId& id) override;
  std::optional<SharedSession> sharedSession(const std::string& token,
                                             std::uint64_t nowMs) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
