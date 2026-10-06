#include "products/journal/adapters/postgres/PgJournalRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

#include <optional>
#include <string>
#include <string_view>

namespace wm {

namespace {
// day and updated_at are pushed through ::text / an epoch cast so no calendar parsing happens in
// C++: the pqxx date/time readers differ between the macOS and CI Linux builds.
constexpr std::string_view kPageColumns =
    "user_id, day::text AS day, body, mood, energy, source, "
    "stamp_ms, stamp_counter, stamp_actor, "
    "(extract(epoch from updated_at) * 1000)::bigint AS updated_ms";

// A stored scale: SQL null is the unanswered state, and a value outside 0..10 that predates the
// check constraint narrows to unanswered rather than failing the read. Templated on the field type
// for the same reason the row is: the two toolchains name these differently.
template <typename Field>
std::optional<Score> scoreFrom(const Field& field) {
  if (field.is_null()) return std::nullopt;
  return Score::from(field.template as<int>());
}

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build.
template <typename Row>
Page pageFrom(const Row& row) {
  return Page{
      UserId{row["user_id"].template as<std::string>()},
      LocalDate{row["day"].template as<std::string>()},
      row["body"].template as<std::string>(),
      scoreFrom(row["mood"]),
      scoreFrom(row["energy"]),
      parseSource(row["source"].template as<std::string>()),
      Hlc{row["stamp_ms"].template as<std::uint64_t>(),
          static_cast<std::uint32_t>(row["stamp_counter"].template as<std::uint64_t>()),
          row["stamp_actor"].template as<std::string>()},
      row["updated_ms"].template as<std::uint64_t>()};
}

}

PgJournalRepository::PgJournalRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

std::optional<Page> PgJournalRepository::load(const UserId& user, const LocalDate& day) {
  // The pqxx handles are released in their own scope before the return.
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

// Equal stamps break their tie by day, so one cohort pages the same way on every read.
std::vector<Page> PgJournalRepository::since(const UserId& user, const Hlc& cursor, int limit) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  pqxx::result rows = txn.exec_params(
      "SELECT " + std::string(kPageColumns) +
          " FROM journal_page WHERE user_id = $1::uuid "
          "AND (stamp_ms, stamp_counter, stamp_actor) > ($2::bigint, $3::bigint, $4::text) "
          "ORDER BY stamp_ms ASC, stamp_counter ASC, stamp_actor ASC, day ASC LIMIT $5",
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


}
