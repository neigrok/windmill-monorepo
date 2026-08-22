#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/adapters/postgres/PgSweepMutex.h"
#include "products/roadmap/ports/ReminderRepository.h"

#include <functional>
#include <memory>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// The reminder engine against Postgres. Two things about this class are load-bearing.
//
// EVERY calendar conversion happens in SQL, through AT TIME ZONE. Postgres carries its own IANA
// database, so a slot resolves identically on a macOS dev box and on CI's Linux — which C++
// calendar functions demonstrably do not (this codebase has already been burned by timegm
// diverging between the two). There is no mktime, timegm, localtime_r or chrono time zone here,
// and there must never be one.
//
// `readinessFor` is the ONE place readiness is computed, and it computes it by running the real
// UnlockRules::derive over the real graph — the same code the UI runs. A bespoke "is available"
// query would eventually disagree with the app, and an email promising steps the app doesn't
// show breaks the footer's promise far harder than any timing bug ever could.
class PgReminderRepository : public ReminderRepository {
public:
  explicit PgReminderRepository(std::shared_ptr<PgPool> pool);

  bool underSweepLock(const std::function<void()>& pass) override;

  std::vector<DueUser> dueNow(std::uint64_t nowMs, int limit) override;
  std::vector<TreeReadiness> readinessFor(const UserId& user) override;
  std::uint64_t lastActiveAtMs(const UserId& user) override;
  std::uint64_t accountCreatedAtMs(const UserId& user) override;

  bool claimWeek(const UserId& user, const std::string& slotDate,
                 const ReminderDecision& decision) override;
  void closeWeek(const UserId& user, const std::string& slotDate, WeekOutcome outcome) override;

  std::optional<ReminderSettings> settingsFor(const UserId& user) override;
  bool upsertSettings(const UserId& user, bool enabled, const std::string& ianaTz) override;
  bool stopMailing(const Email& address) override;
  void liftSuppression(const UserId& user) override;

  void setPauseDigest(const UserId& user, const std::string& digest) override;
  std::optional<UserId> userByPauseDigest(const std::string& digest) override;
  void pause(const UserId& user) override;

private:
  std::shared_ptr<PgPool> pool_;
  PgSweepMutex sweepLock_;
};

}
