#pragma once

#include "platform/domain/Auth.h"
#include "platform/ports/MailSuppression.h"
#include "products/journal/domain/NudgePlan.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// The nudge settings a user owns, read whole and written whole (the HTTP layer read-modify-writes a
// partial PATCH against this). next_due_at and slot_day are the DEVICE's materialised schedule — the
// server stores and fires them but never derives them, so the rhythm stays on the phone. All instants
// are epoch ms in the domain; the adapter is the only place a timestamptz is spoken.
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

// What actually became of a claimed day at SEND time — stamped after the decision so a dark-held or
// provider-refused send is distinguishable from a crash between claim and send.
enum class DayOutcome { delivered, refused, held };

// The sweep's seam and the settings store. Every read is owner-scoped. claimDay is the whole
// "at most one per day" guarantee: the ledger primary key IS the mutex, re-checking eligibility
// inside its own transaction, and it clears next_due_at in the same breath so the served instant
// can never fire twice.
//
// It is also journal's MailSuppression (platform/ports/MailSuppression.h): the store that decides
// who gets the nightly knock is the store that can stop it, so the platform webhook needs nothing
// from this product but this one inherited verb.
struct NudgeRepository : MailSuppression {
  virtual bool tryLockSweep() = 0;               // pg advisory lock — work dedup, NOT correctness
  virtual void unlockSweep() = 0;

  virtual std::vector<NudgeDueUser> dueNow(std::uint64_t nowMs, int limit) = 0;
  virtual bool wroteToday(const UserId& user, const LocalDate& day) = 0;

  virtual bool claimDay(const UserId& user, const LocalDate& slotDay, const NudgeDecision& decision) = 0;
  virtual void closeDay(const UserId& user, const LocalDate& slotDay, DayOutcome outcome) = 0;

  virtual std::optional<NudgeSettings> settingsFor(const UserId& user) = 0;
  virtual void upsertSettings(const UserId& user, const NudgeSettings& settings) = 0;

  // MailSuppression: end the nightly nudge for whoever owns that address. What the platform webhook
  // calls after a hard bounce or a spam complaint. It never touches `enabled` — what its owner
  // asked for survives, so lifting the flag restores their choice rather than a default.
  bool stopMailing(const Email& address) override = 0;
  // The inverse, and the only other writer of journal_nudge.suppressed. Keyed by USER, not address,
  // because it is the account owner acting on their own row: NudgeApi calls it when a PATCH that
  // says enabled:true lands on a suppressed row — the deliberate "this address works now". Neither
  // verb touches `enabled`; being wrong costs exactly one more bounce, which suppresses again.
  virtual void liftSuppression(const UserId& user) = 0;

  virtual void setPauseDigest(const UserId& user, const std::string& digest) = 0;
  virtual std::optional<UserId> userByPauseDigest(const std::string& digest) = 0;
  virtual void pause(const UserId& user, std::uint64_t untilMs) = 0;   // "pause for a week"
  virtual void disable(const UserId& user) = 0;                        // unsubscribe / turn off
};

}
