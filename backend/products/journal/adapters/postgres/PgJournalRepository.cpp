#include "products/journal/adapters/postgres/PgJournalRepository.h"

#include "platform/adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

#include <string>
#include <string_view>

namespace wm {

namespace {
// Every read returns the same shape. day and updated_at are pushed through ::text / an epoch cast so
// no timestamptz or calendar parsing ever happens in C++ — the pqxx date/time readers differ between
// the macOS and CI Linux builds, and this keeps both off that path.
constexpr std::string_view kPageColumns =
    "user_id, day::text AS day, body, mood, energy, source, "
    "stamp_ms, stamp_counter, stamp_actor, "
    "(extract(epoch from updated_at) * 1000)::bigint AS updated_ms";

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build, so
// binding it concretely compiles on one and fails on the other.
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
}

PgJournalRepository::PgJournalRepository(std::string connString) : connString_(std::move(connString)) {}

std::optional<Page> PgJournalRepository::load(const UserId& user, const LocalDate& day) {
  // The page is mapped into a named result and the pqxx handles are released in their own scope
  // BEFORE the return, so what leaves this function is a plain NRVO of a fully-formed local — never
  // an optional materialised in the same expression a transaction is being torn down in.
  std::optional<Page> found;
  {
    pqxx::work txn{pgThreadConnection(connString_)};
    pqxx::result rows = txn.exec_params(
        "SELECT " + std::string(kPageColumns) +
            " FROM journal_page WHERE user_id = $1::uuid AND day = $2::date",
        user.str(), day.iso());
    if (!rows.empty()) found = pageFrom(rows[0]);
  }
  return found;
}

std::vector<Page> PgJournalRepository::range(const UserId& user, const LocalDate& from, const LocalDate& to) {
  pqxx::work txn{pgThreadConnection(connString_)};
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
  // fields the domain spaceship and the fake compare on. A two-field compare would treat two devices'
  // (ms, counter) collision as equal and drop whichever page fell past a page boundary from the feed
  // forever (it feeds sync AND the on-device search index). The actor tiebreak makes the order total
  // and deterministic across pages.
  pqxx::work txn{pgThreadConnection(connString_)};
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
  pqxx::work txn{pgThreadConnection(connString_)};
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
  pqxx::work txn{pgThreadConnection(connString_)};
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
  // write that loses is NOT itself trailed: it never held the day, its author's device still has the
  // text (the service hands the winning body back to reconcile against), and trailing every stale
  // replay would grow the revision table without preserving anything that was ever the current page.
  if (!(existingStamp < incoming.stamp)) {
    txn.commit();
    return PageWrite::ignoredStale;
  }

  // Incoming supersedes. A non-empty losing body is appended to the invisible revision trail under
  // its own stamp before the row is overwritten, so "nothing written is ever withdrawn" holds.
  std::string existingBody = row["body"].as<std::string>();
  if (!existingBody.empty()) {
    txn.exec_params(
        "INSERT INTO journal_page_revision (user_id, day, body, stamp_ms, stamp_counter, stamp_actor) "
        "VALUES ($1::uuid, $2::date, $3, $4, $5, $6)",
        incoming.user.str(), incoming.day.iso(), existingBody,
        static_cast<long long>(existingStamp.physicalMs),
        static_cast<long long>(existingStamp.counter), existingStamp.actor);
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
