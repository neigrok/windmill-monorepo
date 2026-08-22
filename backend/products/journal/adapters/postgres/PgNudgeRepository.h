#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/adapters/postgres/PgSweepMutex.h"
#include "products/journal/ports/NudgeRepository.h"

#include <functional>
#include <memory>
#include <string>

namespace wm {

// Nudge storage + the sweep's seam over Postgres, mirroring roadmap's PgReminderRepository. Stateless
// but for the connection string. dueNow is one indexed range scan over journal_nudge_due; claimDay
// is an INSERT … WHERE EXISTS(still-eligible) ON CONFLICT DO NOTHING RETURNING that also clears
// next_due_at, so the ledger PK is the daily mutex and a served instant can never fire twice. All
// instants cross as epoch-ms bigints; timestamptz lives only inside this file (to_timestamp / extract
// epoch), so no C++ calendar maths ever runs — the mac-vs-CI trap the reminder engine documents.
class PgNudgeRepository : public NudgeRepository {
public:
  explicit PgNudgeRepository(std::shared_ptr<PgPool> pool);

  bool underSweepLock(const std::function<void()>& pass) override;
  std::vector<NudgeDueUser> dueNow(std::uint64_t nowMs, int limit) override;
  bool wroteToday(const UserId& user, const LocalDate& day) override;
  bool claimDay(const UserId& user, const LocalDate& slotDay, const NudgeDecision& decision) override;
  void closeDay(const UserId& user, const LocalDate& slotDay, DayOutcome outcome) override;
  std::optional<NudgeSettings> settingsFor(const UserId& user) override;
  void upsertSettings(const UserId& user, const NudgeSettings& settings) override;
  bool stopMailing(const Email& address) override;
  void liftSuppression(const UserId& user) override;
  void setPauseDigest(const UserId& user, const std::string& digest) override;
  std::optional<UserId> userByPauseDigest(const std::string& digest) override;
  void pause(const UserId& user, std::uint64_t untilMs) override;
  void disable(const UserId& user) override;

private:
  std::shared_ptr<PgPool> pool_;
  PgSweepMutex sweepLock_;
};

}
