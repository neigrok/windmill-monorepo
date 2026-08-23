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

// The nudge settings a user owns, read whole and written whole. next_due_at and slot_day are the
// DEVICE's materialised schedule — the server stores and fires them but never derives them. All
// instants are epoch ms in the domain; the adapter is the only place a timestamptz is spoken.
struct NudgeSettings {
  bool enabled = false;
  std::string channel = "email";                 // email | inapp
  std::optional<std::uint64_t> nextDueAtMs;      // device-materialised; unset ⇒ never send
  std::optional<LocalDate> slotDay;              // the local day nextDueAt belongs to
  std::optional<std::uint64_t> pausedUntilMs;
  bool suppressed = false;
};

// One user the sweep found due right now: everything a send needs plus the paused instant, so the
// pure decide can be built with no second read.
struct NudgeDueUser {
  UserId user;
  Email email;
  LocalDate slotDay;
  std::uint64_t slotInstantMs = 0;
  std::uint64_t pausedUntilMs = 0;               // 0 = not paused
};

// What became of a claimed day at SEND time — stamped after the decision, so a held or refused send
// is distinguishable from a crash between claim and send.
enum class DayOutcome { delivered, refused, held };

// The sweep's seam and the settings store. Every read is owner-scoped. claimDay carries the
// "at most one per day" guarantee: the ledger primary key IS the mutex, it re-checks eligibility
// inside its own transaction, and it clears next_due_at in the same breath so the served instant
// can never fire twice.
//
// It is also journal's MailSuppression (platform/ports/MailSuppression.h) and the sweep's
// SweepMutex (platform/ports/SweepMutex.h) — a pg advisory lock for work dedup, NOT correctness.
struct NudgeRepository : MailSuppression, SweepMutex {
  virtual std::vector<NudgeDueUser> dueNow(std::uint64_t nowMs, int limit) = 0;
  virtual bool wroteToday(const UserId& user, const LocalDate& day) = 0;

  virtual bool claimDay(const UserId& user, const LocalDate& slotDay, const NudgeDecision& decision) = 0;
  virtual void closeDay(const UserId& user, const LocalDate& slotDay, DayOutcome outcome) = 0;

  virtual std::optional<NudgeSettings> settingsFor(const UserId& user) = 0;
  virtual void upsertSettings(const UserId& user, const NudgeSettings& settings) = 0;

  // MailSuppression: end the nightly nudge for whoever owns that address, called by the platform
  // webhook after a hard bounce or a spam complaint. It never touches `enabled`.
  bool stopMailing(const Email& address) override = 0;
  // The inverse, and the only other writer of journal_nudge.suppressed. Keyed by USER, not address:
  // NudgeApi calls it when a PATCH saying enabled:true lands on a suppressed row. Neither verb
  // touches `enabled`.
  virtual void liftSuppression(const UserId& user) = 0;

  virtual void setPauseDigest(const UserId& user, const std::string& digest) = 0;
  virtual std::optional<UserId> userByPauseDigest(const std::string& digest) = 0;
  virtual void pause(const UserId& user, std::uint64_t untilMs) = 0;   // "pause for a week"
  virtual void disable(const UserId& user) = 0;                        // unsubscribe / turn off
};

}
