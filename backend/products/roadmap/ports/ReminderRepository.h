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

// `slotDate` is the slot's LOCAL date (the ledger's week key), `slotInstantMs` the same slot as a
// UTC instant. Postgres resolves both; C++ never converts a timezone.
struct DueUser {
  UserId user;
  Email email;
  std::string slotDate;
  std::uint64_t slotInstantMs = 0;
};

// The defaults must match the column defaults in db/schema.sql. An empty timezone is the "never
// due" state: no slot can be materialized without one.
struct ReminderSettings {
  bool enabled = false;
  std::string timezone;
  int slotDow = kDefaultSlotDow;
  int slotMinute = kDefaultSlotMinute;
  bool suppressed = false;
};

// Exactly one is recorded for every claim, which tells a week we deliberately withheld from one
// whose process died between the claim and the mail.
enum class WeekOutcome { held, delivered, refused };

// The ordering the implementation must honour is DECIDE → CLAIM → SEND: `claimWeek` commits the
// ledger row that is the permission slip to perform I/O, and only a claim that returned true may be
// followed by a mail. The inherited SweepMutex is a fleet-wide work lock, deliberately not the
// correctness mechanism (the claim is), so the sweep stays correct with the lock a no-op.
struct ReminderRepository : MailSuppression, SweepMutex {
  // Whose slot has arrived, oldest first, capped. One indexed range scan on `next_due_at <= now`.
  virtual std::vector<DueUser> dueNow(std::uint64_t nowMs, int limit) = 0;

  // Readiness is computed by running the real UnlockRules over the real graph, never by a bespoke
  // "is available" query.
  virtual std::vector<TreeReadiness> readinessFor(const UserId& user) = 0;
  virtual std::uint64_t lastActiveAtMs(const UserId& user) = 0;
  virtual std::uint64_t accountCreatedAtMs(const UserId& user) = 0;

  // Insert this week's ledger row and advance the pointer past THIS slot, in ONE committed
  // transaction. False means another sweep already owns this week: fall silent without mailing.
  // `slotDate` names the slot on both halves, so a sweep that lost the race cannot advance a pointer
  // the winner already moved.
  virtual bool claimWeek(const UserId& user, const std::string& slotDate,
                         const ReminderDecision& decision) = 0;
  // Never retried: a claimed row that never reaches here is indistinguishable from one whose mail
  // landed but whose update was lost.
  virtual void closeWeek(const UserId& user, const std::string& slotDate, WeekOutcome outcome) = 0;

  virtual std::optional<ReminderSettings> settingsFor(const UserId& user) = 0;
  // False when the timezone is not one Postgres knows — the only way this write fails.
  virtual bool upsertSettings(const UserId& user, bool enabled, const std::string& ianaTz) = 0;

  // Nothing in the sign-in path reads that column, so the magic link keeps reaching an address this
  // silenced.
  bool stopMailing(const Email& address) override = 0;
  // Keyed by USER, not address: the account owner acting on their own row. Neither verb touches
  // `enabled`.
  virtual void liftSuppression(const UserId& user) = 0;

  // The pause link's credential: the digest at rest, the secret only ever in the mail that carries it.
  virtual void setPauseDigest(const UserId& user, const std::string& digest) = 0;
  virtual std::optional<UserId> userByPauseDigest(const std::string& digest) = 0;
  virtual void pause(const UserId& user) = 0;
};

}
