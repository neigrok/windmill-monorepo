#pragma once

#include "platform/domain/Auth.h"
#include "platform/ports/MailSuppression.h"
#include "platform/ports/SweepMutex.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Reminders.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// One user the sweep is about to consider. `slotDate` is the selecting slot's LOCAL date (the
// ledger's week key) and `slotInstantMs` the same slot as a UTC instant; Postgres resolves both,
// C++ never converts a timezone.
struct DueUser {
  UserId user;
  Email email;
  std::string slotDate;
  std::uint64_t slotInstantMs = 0;
};

// The settings surface, as the account page reads and writes it. The defaults are what a user
// with no row yet reads back, so they must match the column defaults in db/schema.sql. An empty
// timezone is the "never due" state: no slot can be materialized without one.
struct ReminderSettings {
  bool enabled = false;
  std::string timezone;
  int slotDow = kDefaultSlotDow;
  int slotMinute = kDefaultSlotMinute;
  bool suppressed = false;
};

// What became of a week that was successfully claimed. Exactly one of these is recorded for every
// claim, which is what tells a week we deliberately withheld from a week whose process died
// between the claim and the mail.
enum class WeekOutcome { held, delivered, refused };

// Every read and write the reminder engine makes. The ordering the implementation must honour
// is DECIDE → CLAIM → SEND: `claimWeek` commits the ledger row that is the permission slip to
// perform I/O, and only a claim that returned true may be followed by a mail.
//
// It is also roadmap's MailSuppression, and the sweep's SweepMutex — a fleet-wide work lock,
// deliberately not the correctness mechanism (the claim below is), so the sweep stays correct
// with the lock a no-op.
struct ReminderRepository : MailSuppression, SweepMutex {
  // Whose slot has arrived, oldest first, capped. One indexed range scan on `next_due_at <= now`.
  virtual std::vector<DueUser> dueNow(std::uint64_t nowMs, int limit) = 0;

  // Everything decide() needs about one user, EXCEPT the decision itself. Readiness is computed by
  // running the real UnlockRules over the real graph, never by a bespoke "is available" query.
  virtual std::vector<TreeReadiness> readinessFor(const UserId& user) = 0;
  virtual std::uint64_t lastActiveAtMs(const UserId& user) = 0;
  virtual std::uint64_t accountCreatedAtMs(const UserId& user) = 0;

  // The claim: insert this week's ledger row and advance the pointer past THIS slot, in ONE
  // committed transaction. False means another sweep already owns this week — the pointer still
  // moved, and the caller must fall silent without mailing anything. `slotDate` names the slot
  // being served on both halves, so a sweep that lost the race cannot advance a pointer the
  // winner already moved.
  virtual bool claimWeek(const UserId& user, const std::string& slotDate,
                         const ReminderDecision& decision) = 0;
  // How the claimed week ended. Must never be retried: a claimed row that never reaches here is
  // indistinguishable from one whose mail landed but whose update was lost.
  virtual void closeWeek(const UserId& user, const std::string& slotDate, WeekOutcome outcome) = 0;

  virtual std::optional<ReminderSettings> settingsFor(const UserId& user) = 0;
  // False when the timezone is not one Postgres knows — the only way this write fails.
  virtual bool upsertSettings(const UserId& user, bool enabled, const std::string& ianaTz) = 0;

  // MailSuppression: end the weekly reminder for whoever owns that address. Nothing in the sign-in
  // path reads that column, so the magic link keeps reaching an address this silenced.
  bool stopMailing(const Email& address) override = 0;
  // The inverse, and the only other writer of reminder_subscription.suppressed. Keyed by USER, not
  // address, because it is the account owner acting on their own row. Neither verb touches
  // `enabled`.
  virtual void liftSuppression(const UserId& user) = 0;

  // The pause link's credential: the digest at rest, the secret only ever in the mail that carries it.
  virtual void setPauseDigest(const UserId& user, const std::string& digest) = 0;
  virtual std::optional<UserId> userByPauseDigest(const std::string& digest) = 0;
  virtual void pause(const UserId& user) = 0;
};

}
