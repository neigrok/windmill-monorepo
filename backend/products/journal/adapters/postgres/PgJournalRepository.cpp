#include "products/journal/adapters/postgres/PgJournalRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

#include <string>
#include <string_view>

namespace wm {

namespace {
// Every read returns the same shape. day and updated_at are pushed through ::text / an epoch cast so
// no timestamptz or calendar parsing happens in C++: the pqxx date/time readers differ between the
// macOS and CI Linux builds.
constexpr std::string_view kPageColumns =
    "user_id, day::text AS day, body, mood, energy, source, "
    "stamp_ms, stamp_counter, stamp_actor, "
    "(extract(epoch from updated_at) * 1000)::bigint AS updated_ms";

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build.
template <typename Row>
Page pageFrom(const Row& row) {
  return Page{
      UserId{row["user_id"].template as<std::string>()},
      LocalDate{row["day"].template as<std::string>()},
      row["body"].template as<std::string>(),
      moodFromInt(row["mood"].template as<int>()),
      energyFromInt(row["energy"].template as<int>()),
      parseSource(row["source"].template as<std::string>()),
      Hlc{row["stamp_ms"].template as<std::uint64_t>(),
          static_cast<std::uint32_t>(row["stamp_counter"].template as<std::uint64_t>()),
          row["stamp_actor"].template as<std::string>()},
      row["updated_ms"].template as<std::uint64_t>()};
}

// What the revision trail may cost. It is append-only and nothing else in the product deletes from
// it, so three bounds, because none of them alone holds:
//
//   per (user, day) — a day edited all afternoon keeps its ten most recent supersessions, so one day
//     cannot evict every other day's history;
//   per user — five hundred rows OR 8 MB, whichever binds first: bytes bound a few large pages, rows
//     bound a flood of one-byte ones;
//   by age — ninety days.
constexpr int kRevisionsPerDay = 10;
constexpr int kRevisionsPerUser = 500;
constexpr long long kRevisionBytesPerUser = 8 * 1024 * 1024;
constexpr int kRevisionRetentionDays = 90;

// Runs in the SAME transaction as the insert it follows, so the trail is never observed above its
// ceiling and a rolled-back write prunes nothing. Ordered newest first and cut from the tail.
void pruneRevisions(pqxx::work& txn, const UserId& user, const LocalDate& day) {
  txn.exec_params(
      "DELETE FROM journal_page_revision WHERE user_id = $1::uuid AND ctid IN ("
      "  SELECT ctid FROM ("
      "    SELECT ctid, row_number() OVER (ORDER BY superseded_at DESC, ctid DESC) AS rank"
      "    FROM journal_page_revision WHERE user_id = $1::uuid AND day = $2::date) ranked"
      "  WHERE rank > $3::int)",
      user.str(), day.iso(), kRevisionsPerDay);

  // One statement for the three user-wide bounds: whichever of rows, bytes or age names a row first
  // takes it. `ROWS BETWEEN` and not the default frame, because rows sharing a superseded_at are
  // peers under RANGE and would each be charged the whole tie's bytes.
  txn.exec_params(
      "DELETE FROM journal_page_revision WHERE user_id = $1::uuid AND ctid IN ("
      "  SELECT ctid FROM ("
      "    SELECT ctid, superseded_at,"
      "           row_number() OVER w AS rank,"
      "           sum(octet_length(body)) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)"
      "             AS running"
      "    FROM journal_page_revision WHERE user_id = $1::uuid"
      "    WINDOW w AS (ORDER BY superseded_at DESC, ctid DESC)) ranked"
      "  WHERE rank > $2::int OR running > $3::bigint"
      "     OR superseded_at < now() - make_interval(days => $4::int))",
      user.str(), kRevisionsPerUser, kRevisionBytesPerUser, kRevisionRetentionDays);
}
}

PgJournalRepository::PgJournalRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

std::optional<Page> PgJournalRepository::load(const UserId& user, const LocalDate& day) {
  // The page is mapped into a named result and the pqxx handles are released in their own scope
  // BEFORE the return, so what leaves this function is a plain NRVO of a fully-formed local.
  std::optional<Page> found;
  {
    PgLease conn{*pool_};
    pqxx::work txn{*conn};
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kPageColumns) +
            " FROM journal_page WHERE user_id = $1::uuid AND day = $2::date",
        user.str(), day.iso());
    if (!rows.empty()) found = pageFrom(rows[0]);
  }
  return found;
}

std::vector<Page> PgJournalRepository::range(const UserId& user, const LocalDate& from, const LocalDate& to) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kPageColumns) +
          " FROM journal_page WHERE user_id = $1::uuid AND day BETWEEN $2::date AND $3::date "
          "ORDER BY day ASC",
      user.str(), from.iso(), to.iso());

  std::vector<Page> pages;
  for (const auto& row : rows) pages.push_back(pageFrom(row));
  return pages;
}

std::vector<Page> PgJournalRepository::since(const UserId& user, const Hlc& cursor, int limit) {
  // The cursor advances on the FULL Hlc — (stamp_ms, stamp_counter, stamp_actor) — the same three
  // fields the domain spaceship and the fake compare on. A two-field compare would treat two
  // devices' (ms, counter) collision as equal and drop a page from the feed forever. The actor
  // tiebreak makes the order total and deterministic across pages.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kPageColumns) +
          " FROM journal_page WHERE user_id = $1::uuid "
          "AND (stamp_ms, stamp_counter, stamp_actor) > ($2::bigint, $3::bigint, $4::text) "
          "ORDER BY stamp_ms ASC, stamp_counter ASC, stamp_actor ASC LIMIT $5",
      user.str(), static_cast<long long>(cursor.physicalMs),
      static_cast<long long>(cursor.counter), cursor.actor, limit);

  std::vector<Page> pages;
  for (const auto& row : rows) pages.push_back(pageFrom(row));
  return pages;
}

std::vector<Page> PgJournalRepository::all(const UserId& user) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kPageColumns) +
          " FROM journal_page WHERE user_id = $1::uuid ORDER BY day ASC",
      user.str());

  std::vector<Page> pages;
  for (const auto& row : rows) pages.push_back(pageFrom(row));
  return pages;
}

PageWrite PgJournalRepository::save(const Page& incoming) {
  // Read-modify-write in one transaction: the row is locked FOR UPDATE so the revision capture sees
  // exactly the body this write is about to supersede — a bare ON CONFLICT could not carry the loser
  // into the revision trail.
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result existing = txn.exec_params(
      "SELECT body, stamp_ms, stamp_counter, stamp_actor FROM journal_page "
      "WHERE user_id = $1::uuid AND day = $2::date FOR UPDATE",
      incoming.user.str(), incoming.day.iso());

  if (existing.empty()) {
    txn.exec_params(
        "INSERT INTO journal_page "
        "(user_id, day, body, mood, energy, source, stamp_ms, stamp_counter, stamp_actor, updated_at) "
        "VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7, $8, $9, now())",
        incoming.user.str(), incoming.day.iso(), incoming.body,
        toInt(incoming.mood), toInt(incoming.energy), toString(incoming.source),
        static_cast<long long>(incoming.stamp.physicalMs),
        static_cast<long long>(incoming.stamp.counter), incoming.stamp.actor);
    txn.commit();
    return PageWrite::stored;
  }

  const auto& row = existing[0];
  Hlc existingStamp{row["stamp_ms"].as<std::uint64_t>(),
                    static_cast<std::uint32_t>(row["stamp_counter"].as<std::uint64_t>()),
                    row["stamp_actor"].as<std::string>()};

  // The one convergence rule, shared verbatim with the fake and the domain: incoming wins iff it
  // STRICTLY dominates the stored stamp via the Hlc spaceship — a tie keeps what is stored. A stale
  // write that loses is NOT itself trailed: it never held the day, and its author's device still has
  // the text, since the service hands the winning body back to reconcile against.
  if (!(existingStamp < incoming.stamp)) {
    txn.commit();
    return PageWrite::ignoredStale;
  }

  // Incoming supersedes. A non-empty losing body is appended to the invisible revision trail under
  // its own stamp before the row is overwritten, and the trail is pruned to its bounds in the same
  // breath.
  std::string existingBody = row["body"].as<std::string>();
  if (!existingBody.empty()) {
    txn.exec_params(
        "INSERT INTO journal_page_revision (user_id, day, body, stamp_ms, stamp_counter, stamp_actor) "
        "VALUES ($1::uuid, $2::date, $3, $4, $5, $6)",
        incoming.user.str(), incoming.day.iso(), existingBody,
        static_cast<long long>(existingStamp.physicalMs),
        static_cast<long long>(existingStamp.counter), existingStamp.actor);
    pruneRevisions(txn, incoming.user, incoming.day);
  }

  txn.exec_params(
      "UPDATE journal_page SET body = $3, mood = $4, energy = $5, source = $6, "
      "stamp_ms = $7, stamp_counter = $8, stamp_actor = $9, updated_at = now() "
      "WHERE user_id = $1::uuid AND day = $2::date",
      incoming.user.str(), incoming.day.iso(), incoming.body,
      toInt(incoming.mood), toInt(incoming.energy), toString(incoming.source),
      static_cast<long long>(incoming.stamp.physicalMs),
      static_cast<long long>(incoming.stamp.counter), incoming.stamp.actor);
  txn.commit();
  return PageWrite::superseded;
}

}
