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

// One fleet-wide lock for the sweep's work, not its correctness; the claimed day row is that.
constexpr std::string_view kSweepLock = "hashtext('journal_nudge_sweep')::bigint";

// The ledger's two free columns: the decision is the coarse verdict, the reason is why.
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

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build. The
// row carries the slot in both currencies — the local day, the ledger's dedup key, and the UTC
// instant the lateness gate measures against — plus the paused instant.
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
  // Whose slot has arrived. next_due_at is the device's materialised instant, only ever fired here.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT n.user_id, u.email, n.slot_day::text AS slot_day, "
      "(extract(epoch from n.next_due_at) * 1000)::bigint AS instant_ms, "
      "COALESCE((extract(epoch from n.paused_until) * 1000)::bigint, 0) AS paused_ms "
      "FROM journal_nudge n JOIN users u ON u.id = n.user_id "
      "WHERE n.enabled AND NOT n.suppressed AND n.next_due_at IS NOT NULL AND n.slot_day IS NOT NULL "
      // A row in `users` is the proven-address signal; the soft-close stamp is the only extra gate.
      "AND u.deleted_at IS NULL AND n.next_due_at <= to_timestamp($1::bigint / 1000.0) "
      "ORDER BY n.next_due_at ASC LIMIT $2",
      static_cast<long long>(nowMs), limit);

  std::vector<NudgeDueUser> due;
  due.reserve(rows.size());
  for (const auto& row : rows) due.push_back(dueUserFrom(row));
  return due;
}

bool PgNudgeRepository::wroteToday(const UserId& user, const LocalDate& day) {
  // slot_day is the local day, so this is a point lookup on the journal_page primary key.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT EXISTS(SELECT 1 FROM journal_page WHERE user_id = $1::uuid AND day = $2::date) AS wrote",
      user.str(), day.iso());
  return rows[0]["wrote"].as<bool>();
}

bool PgNudgeRepository::claimDay(const UserId& user, const LocalDate& slotDay,
                                 const NudgeDecision& decision) {
  // The whole "at most one per day" guarantee: the primary key is the mutex, and whoever inserts the
  // row owns the day. The EXISTS re-asks dueNow's question inside the transaction, so someone who
  // paused, bounced or closed their account while the batch ran is not mailed.
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

  // Clear the served instant in the same transaction, so it cannot fire twice; the device
  // materialises the next one.
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
    // The only stamp meaning a person received something. Its absence on a claimed row is ambiguous,
    // so such a row is never retried.
    txn.exec_params(
        "UPDATE journal_nudge_day SET sent_at = now() "
        "WHERE user_id = $1::uuid AND slot_day = $2::date",
        user.str(), slotDay.iso());
    txn.commit();
    return;
  }

  // The day stays claimed and the ledger's reason says which; sent_at is left null.
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

  // next_due_at, slot_day and the pause are nullable: a null column stays an unset optional, so
  // "unset means never send" survives the round trip.
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
  // Written whole; the HTTP layer read-modify-writes a partial PATCH against settingsFor. The three
  // instants cross as epoch-ms bigints and become timestamptz only in to_timestamp here; an unset
  // optional lands as SQL null, which the partial index turns into "never send".
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
  // Idempotent: the value written is a constant, so a redelivered webhook performs the identical
  // write. It inserts when there is no row, since most accounts have none. `enabled` is left exactly
  // as its owner set it. users.email is citext, so the address matches however the provider cased it.
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
  // Keyed by user id. `enabled` is untouched here: upsertSettings writes it.
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
