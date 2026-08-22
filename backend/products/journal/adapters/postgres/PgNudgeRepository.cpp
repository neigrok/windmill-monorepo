#include "products/journal/adapters/postgres/PgNudgeRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wm {

namespace {

// One fleet-wide lock for the sweep's WORK (not its correctness — the claimed day row is that).
// PgSweepMutex owns everything about how it is held; this names it.
constexpr std::string_view kSweepLock = "hashtext('journal_nudge_sweep')::bigint";

// The ledger's two free columns speak the same words the schema comment fixes. The decision is the
// coarse verdict; the reason is why. Neither has any logic to get wrong, so both live here as flat
// switches over the domain enums the pure decide already produced.
const char* decisionText(NudgeOutcome outcome) {
  return outcome == NudgeOutcome::send ? "sent" : "skipped";
}

const char* reasonText(NudgeSkipReason reason) {
  switch (reason) {
    case NudgeSkipReason::none:         return "ok";
    case NudgeSkipReason::alreadyWrote: return "already-wrote";
    case NudgeSkipReason::paused:       return "paused";
    case NudgeSkipReason::tooLate:      return "too-late";
  }
  return "ok";
}

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build, so
// binding it concretely compiles on one and fails on the other. The row carries the slot back in
// both currencies — the LOCAL day, which is the ledger's dedup key, and the UTC instant the
// lateness gate measures against — plus the paused instant, so the pure decide needs no second read.
template <typename Row>
NudgeDueUser dueUserFrom(const Row& row) {
  return NudgeDueUser{
      UserId{row["user_id"].template as<std::string>()},
      Email{row["email"].template as<std::string>()},
      LocalDate{row["slot_day"].template as<std::string>()},
      row["instant_ms"].template as<std::uint64_t>(),
      row["paused_ms"].template as<std::uint64_t>()};
}

}

PgNudgeRepository::PgNudgeRepository(std::shared_ptr<PgPool> pool)
    : pool_(pool), sweepLock_(pool, std::string(kSweepLock), "journal nudge") {}

bool PgNudgeRepository::underSweepLock(const std::function<void()>& pass) {
  return sweepLock_.underSweepLock(pass);
}

std::vector<NudgeDueUser> PgNudgeRepository::dueNow(std::uint64_t nowMs, int limit) {
  // The sweep's whole question, and the only one it is allowed to ask about time: whose slot has
  // arrived. next_due_at is the DEVICE's materialised instant — we never derive it, only fire it.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT n.user_id, u.email, n.slot_day::text AS slot_day, "
      "(extract(epoch from n.next_due_at) * 1000)::bigint AS instant_ms, "
      "COALESCE((extract(epoch from n.paused_until) * 1000)::bigint, 0) AS paused_ms "
      "FROM journal_nudge n JOIN users u ON u.id = n.user_id "
      "WHERE n.enabled AND NOT n.suppressed AND n.next_due_at IS NOT NULL AND n.slot_day IS NOT NULL "
      // A row in `users` only ever comes from a consumed magic link or Google sign-in, so existing
      // here IS the proven-address signal; the soft-close stamp is the only extra gate.
      "AND u.deleted_at IS NULL AND n.next_due_at <= to_timestamp($1::bigint / 1000.0) "
      "ORDER BY n.next_due_at ASC LIMIT $2",
      static_cast<long long>(nowMs), limit);

  std::vector<NudgeDueUser> due;
  due.reserve(rows.size());
  for (const auto& row : rows) due.push_back(dueUserFrom(row));
  return due;
}

bool PgNudgeRepository::wroteToday(const UserId& user, const LocalDate& day) {
  // The "did they already write today?" fact the pure decide gates on. slot_day IS the local day, so
  // this is a single point lookup on the journal_page primary key.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT EXISTS(SELECT 1 FROM journal_page WHERE user_id = $1::uuid AND day = $2::date) AS wrote",
      user.str(), day.iso());
  return rows[0]["wrote"].as<bool>();
}

bool PgNudgeRepository::claimDay(const UserId& user, const LocalDate& slotDay,
                                 const NudgeDecision& decision) {
  // The permission slip, and the whole of the "at most one per day" guarantee: the primary key is
  // the mutex. Whoever inserts the row owns the day; everyone else gets nothing back and must fall
  // silent. The EXISTS re-asks, inside the transaction, the question dueNow asked minutes ago —
  // someone who paused, bounced, or closed their account while this batch ran must not be mailed,
  // and rows read up front cannot know that on their own.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result claimed = txn.exec_params(
      "INSERT INTO journal_nudge_day (user_id, slot_day, decision, reason) "
      "SELECT $1::uuid, $2::date, $3, $4 "
      "WHERE EXISTS (SELECT 1 FROM journal_nudge s JOIN users u ON u.id = s.user_id "
      "              WHERE s.user_id = $1::uuid AND s.enabled AND NOT s.suppressed "
      "                AND u.deleted_at IS NULL) "
      "ON CONFLICT (user_id, slot_day) DO NOTHING RETURNING user_id",
      user.str(), slotDay.iso(), decisionText(decision.outcome), reasonText(decision.reason));

  if (claimed.empty()) {
    txn.commit();
    return false;
  }

  // Won the day: clear the served instant in the same breath, so the very same instant can never
  // fire a second time. The device materialises the next one from its own rhythm; the server, having
  // no timezone and no slot maths, never derives it.
  txn.exec_params(
      "UPDATE journal_nudge SET next_due_at = NULL, updated_at = now() WHERE user_id = $1::uuid",
      user.str());
  txn.commit();
  return true;
}

void PgNudgeRepository::closeDay(const UserId& user, const LocalDate& slotDay, DayOutcome outcome) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  if (outcome == DayOutcome::delivered) {
    // The one stamp that means a person actually received something. Its absence on a claimed row is
    // ambiguous by construction — the mail may well have landed — which is exactly why such a row is
    // never retried.
    txn.exec_params(
        "UPDATE journal_nudge_day SET sent_at = now() "
        "WHERE user_id = $1::uuid AND slot_day = $2::date",
        user.str(), slotDay.iso());
    txn.commit();
    return;
  }

  // Held by the arming gate, or refused by the provider. Either way the day stays claimed and the
  // ledger's reason says which; sent_at is left null, so a dark rollout does not leave every held row
  // looking like a crash between claim and send.
  txn.exec_params(
      "UPDATE journal_nudge_day SET reason = $3 "
      "WHERE user_id = $1::uuid AND slot_day = $2::date",
      user.str(), slotDay.iso(), outcome == DayOutcome::held ? "held" : "send-failed");
  txn.commit();
}

std::optional<NudgeSettings> PgNudgeRepository::settingsFor(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT enabled, channel, "
      "(extract(epoch from next_due_at) * 1000)::bigint AS due_ms, "
      "slot_day::text AS slot_day, "
      "(extract(epoch from paused_until) * 1000)::bigint AS paused_ms, "
      "suppressed FROM journal_nudge WHERE user_id = $1::uuid",
      user.str());
  if (rows.empty()) return std::nullopt;

  // The device-materialised schedule (next_due_at, slot_day) and the pause are all nullable: a null
  // column stays an unset optional, so "unknown ⇒ never send" survives the round trip unwidened.
  const auto& row = rows[0];
  NudgeSettings settings;
  settings.enabled = row["enabled"].as<bool>();
  settings.channel = row["channel"].as<std::string>();
  if (!row["due_ms"].is_null()) settings.nextDueAtMs = row["due_ms"].as<std::uint64_t>();
  if (!row["slot_day"].is_null()) settings.slotDay = LocalDate{row["slot_day"].as<std::string>()};
  if (!row["paused_ms"].is_null()) settings.pausedUntilMs = row["paused_ms"].as<std::uint64_t>();
  settings.suppressed = row["suppressed"].as<bool>();
  return settings;
}

void PgNudgeRepository::upsertSettings(const UserId& user, const NudgeSettings& settings) {
  // Written whole (the HTTP layer read-modify-writes a partial PATCH against settingsFor). The three
  // instants cross as epoch-ms bigints and become timestamptz only inside to_timestamp here; an unset
  // optional is appended as SQL null, and to_timestamp(NULL) is NULL, so no branch in the SQL is
  // needed — the column simply lands null and the partial index turns it into "never send".
  pqxx::params params;
  params.append(user.str());
  params.append(settings.enabled);
  params.append(settings.channel);
  if (settings.nextDueAtMs) params.append(static_cast<long long>(*settings.nextDueAtMs));
  else params.append();
  if (settings.slotDay) params.append(settings.slotDay->iso());
  else params.append();
  if (settings.pausedUntilMs) params.append(static_cast<long long>(*settings.pausedUntilMs));
  else params.append();

  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec(
      "INSERT INTO journal_nudge "
      "(user_id, enabled, channel, next_due_at, slot_day, paused_until, updated_at) "
      "VALUES ($1::uuid, $2, $3, to_timestamp($4::bigint / 1000.0), $5::date, "
      "        to_timestamp($6::bigint / 1000.0), now()) "
      "ON CONFLICT (user_id) DO UPDATE SET "
      "enabled = EXCLUDED.enabled, channel = EXCLUDED.channel, "
      "next_due_at = EXCLUDED.next_due_at, slot_day = EXCLUDED.slot_day, "
      "paused_until = EXCLUDED.paused_until, updated_at = now()",
      params);
  txn.commit();
}

bool PgNudgeRepository::stopMailing(const Email& address) {
  // One statement, and idempotent because the value it writes is a constant: a redelivered webhook
  // performs the identical write and changes nothing, which is what makes a dedup table unnecessary
  // rather than merely absent. The mirror of roadmap's PgReminderRepository::stopMailing, on the
  // one table journal mails from.
  //
  // It INSERTS when there is no row, and that is deliberate. A journal_nudge row appears the first
  // time a device pushes a schedule, so most accounts have none — yet a bounce on their sign-in
  // mail still proves the mailbox is gone. Without the insert, the day a phone turns nudges on we
  // would knock at a dead address for a night before learning it again. `enabled` is left exactly
  // as its owner set it. users.email is citext, so the address matches however the provider cased
  // it back to us.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result changed = txn.exec_params(
      "INSERT INTO journal_nudge (user_id, suppressed) "
      "SELECT id, true FROM users WHERE email = $1::citext AND deleted_at IS NULL "
      "ON CONFLICT (user_id) DO UPDATE SET suppressed = true, updated_at = now() RETURNING user_id",
      address.value);
  txn.commit();
  return !changed.empty();
}

void PgNudgeRepository::liftSuppression(const UserId& user) {
  // The owner's own hand, keyed by their id: NudgeApi calls this when a PATCH saying enabled:true
  // lands on a suppressed row. `enabled` is untouched here too — the enable that prompted it is
  // written by upsertSettings — and a row that never existed has nothing to lift, so an UPDATE is
  // exact.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "UPDATE journal_nudge SET suppressed = false, updated_at = now() WHERE user_id = $1::uuid",
      user.str());
  txn.commit();
}

void PgNudgeRepository::setPauseDigest(const UserId& user, const std::string& digest) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("UPDATE journal_nudge SET pause_digest = $2 WHERE user_id = $1::uuid",
                  user.str(), digest);
  txn.commit();
}

std::optional<UserId> PgNudgeRepository::userByPauseDigest(const std::string& digest) {
  if (digest.empty()) return std::nullopt;  // the never-set sentinel must never resolve to anyone
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT user_id::text AS user_id FROM journal_nudge "
      "WHERE pause_digest = $1 AND pause_digest <> ''",
      digest);
  if (rows.empty()) return std::nullopt;
  return UserId{rows[0]["user_id"].as<std::string>()};
}

void PgNudgeRepository::pause(const UserId& user, std::uint64_t untilMs) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params(
      "UPDATE journal_nudge SET paused_until = to_timestamp($2::bigint / 1000.0), updated_at = now() "
      "WHERE user_id = $1::uuid",
      user.str(), static_cast<long long>(untilMs));
  txn.commit();
}

void PgNudgeRepository::disable(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec_params("UPDATE journal_nudge SET enabled = false, updated_at = now() WHERE user_id = $1::uuid",
                  user.str());
  txn.commit();
}

}
