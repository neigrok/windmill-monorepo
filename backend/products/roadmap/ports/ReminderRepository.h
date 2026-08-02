#pragma once

#include "platform/domain/Auth.h"
#include "platform/ports/MailSuppression.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/domain/Reminders.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// One user the sweep is about to consider: who they are, where to write, and the slot that
// selected them — its LOCAL date (the ledger's week key) and its UTC instant. Both are resolved
// by Postgres, which ships its own IANA database and therefore behaves identically on a macOS
// dev box and on CI's Linux; C++ never converts a timezone.
struct DueUser {
  UserId user;
  Email email;
  std::string slotDate;
  std::uint64_t slotInstantMs = 0;
};

// The settings surface, as the account page reads and writes it. The defaults are what a user
// with no row yet reads back, so they must match the column defaults in db/schema.sql.
// An empty timezone is the "never due" state: no slot can be materialized without one, so the
// partial index never selects the row — silence, rather than mailing a US user at 4am.
struct ReminderSettings {
  bool enabled = false;
  std::string timezone;
  int slotDow = kDefaultSlotDow;
  int slotMinute = kDefaultSlotMinute;
  bool suppressed = false;
};

// What became of a week that was successfully claimed. Exactly one of these is recorded for
// every claim, which is what lets the ledger tell a week we deliberately withheld from a week
// whose process died between the claim and the mail — during a dark rollout EVERY row would
// otherwise look like the crash.
enum class WeekOutcome { held, delivered, refused };

// Every read and write the reminder engine makes. The ordering the implementation must honour
// is DECIDE → CLAIM → SEND: `claimWeek` commits the ledger row that is the permission slip to
// perform I/O, and only a claim that returned true may be followed by a mail.
//
// It is also roadmap's MailSuppression (platform/ports/MailSuppression.h): the store that decides
// who gets the weekly mail is the store that can stop it, so the platform webhook needs nothing
// from this product but this one inherited verb.
struct ReminderRepository : MailSuppression {

  // A fleet-wide mutex so two processes sharing one database cannot duplicate the WORK. It is
  // deliberately not the correctness mechanism — the claim below is — so the sweep stays correct
  // with both of these returning true and doing nothing.
  virtual bool tryLockSweep() = 0;
  virtual void unlockSweep() = 0;

  // Whose slot has arrived, oldest first, capped. One indexed range scan — the sweep knows
  // nothing about calendars, only about `next_due_at <= now`.
  virtual std::vector<DueUser> dueNow(std::uint64_t nowMs, int limit) = 0;

  // Everything decide() needs about one user, EXCEPT the decision itself. `readinessFor` is the
  // single place readiness is computed, and it computes it by running the real UnlockRules over
  // the real graph — never by a bespoke "is available" query.
  virtual std::vector<TreeReadiness> readinessFor(const UserId& user) = 0;
  virtual std::uint64_t lastActiveAtMs(const UserId& user) = 0;
  virtual std::uint64_t accountCreatedAtMs(const UserId& user) = 0;

  // The claim: insert this week's ledger row and advance the pointer past THIS slot, in ONE
  // committed transaction. False means another sweep already owns this week — the pointer still
  // moved, and the caller must fall silent without mailing anything. `slotDate` names the slot
  // being served on both halves, so a sweep that lost the race cannot advance a pointer the
  // winner already moved and quietly cost its owner a second week.
  virtual bool claimWeek(const UserId& user, const std::string& slotDate,
                         const ReminderDecision& decision) = 0;
  // How the claimed week ended. A claimed row that never reaches here is indistinguishable from
  // one whose mail landed but whose update was lost, which is exactly why it must never be
  // retried.
  virtual void closeWeek(const UserId& user, const std::string& slotDate, WeekOutcome outcome) = 0;

  virtual std::optional<ReminderSettings> settingsFor(const UserId& user) = 0;
  // False when the timezone is not one Postgres knows — the only way this write fails.
  virtual bool upsertSettings(const UserId& user, bool enabled, const std::string& ianaTz) = 0;

  // MailSuppression: end the weekly reminder for whoever owns that address. What the platform
  // webhook calls after a hard bounce or a spam complaint, and roadmap's only writer of
  // reminder_subscription.suppressed. Nothing in the sign-in path reads that column, so the magic
  // link keeps reaching an address this silenced — it is the one door back into the account.
  bool stopMailing(const Email& address) override = 0;

  // The pause link's credential, stored exactly like every other secret in this codebase: the
  // digest at rest, the secret only ever in the mail that carries it.
  virtual void setPauseDigest(const UserId& user, const std::string& digest) = 0;
  virtual std::optional<UserId> userByPauseDigest(const std::string& digest) = 0;
  virtual void pause(const UserId& user) = 0;
};

}
