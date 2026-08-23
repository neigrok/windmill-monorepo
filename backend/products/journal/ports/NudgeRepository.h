#pragma once

#include "platform/domain/Auth.h"
#include "platform/ports/MailSuppression.h"
#include "platform/ports/SweepMutex.h"
#include "products/journal/domain/NudgePlan.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// Read whole and written whole. nextDueAtMs and slotDay are the device's materialised schedule:
// the server stores and fires them, never derives them. All instants are epoch ms.
struct NudgeSettings {
  bool enabled = false;
  std::string channel = "email";                 // email | inapp
  std::optional<std::uint64_t> nextDueAtMs;      // device-materialised; unset ⇒ never send
  std::optional<LocalDate> slotDay;              // the local day nextDueAt belongs to
  std::optional<std::uint64_t> pausedUntilMs;
  bool suppressed = false;
};

// One user the sweep found due right now: everything the pure decide needs, with no second read.
struct NudgeDueUser {
  UserId user;
  Email email;
  LocalDate slotDay;
  std::uint64_t slotInstantMs = 0;
  std::uint64_t pausedUntilMs = 0;               // 0 = not paused
};

// What became of a claimed day at send time, stamped after the decision: a crash between claim and
// send leaves no outcome.
enum class DayOutcome { delivered, refused, held };

// Every read is owner-scoped. claimDay carries the "at most one per day" guarantee: the ledger
// primary key is the mutex, eligibility is re-checked inside its own transaction, and next_due_at is
// cleared in the same breath so the served instant cannot fire twice. The inherited SweepMutex is an
// advisory lock for work dedup, not for correctness.
struct NudgeRepository : MailSuppression, SweepMutex {
  virtual std::vector<NudgeDueUser> dueNow(std::uint64_t nowMs, int limit) = 0;
  virtual bool wroteToday(const UserId& user, const LocalDate& day) = 0;

  virtual bool claimDay(const UserId& user, const LocalDate& slotDay, const NudgeDecision& decision) = 0;
  virtual void closeDay(const UserId& user, const LocalDate& slotDay, DayOutcome outcome) = 0;

  virtual std::optional<NudgeSettings> settingsFor(const UserId& user) = 0;
  virtual void upsertSettings(const UserId& user, const NudgeSettings& settings) = 0;

  // Ends the nightly nudge for whoever owns that address, after a hard bounce or spam complaint.
  // Never touches `enabled`.
  bool stopMailing(const Email& address) override = 0;
  // The inverse, keyed by user rather than address. Never touches `enabled`.
  virtual void liftSuppression(const UserId& user) = 0;

  virtual void setPauseDigest(const UserId& user, const std::string& digest) = 0;
  virtual std::optional<UserId> userByPauseDigest(const std::string& digest) = 0;
  virtual void pause(const UserId& user, std::uint64_t untilMs) = 0;   // "pause for a week"
  virtual void disable(const UserId& user) = 0;                        // unsubscribe / turn off
};

}
