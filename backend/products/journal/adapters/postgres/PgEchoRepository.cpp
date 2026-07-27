#include "products/journal/adapters/postgres/PgEchoRepository.h"

#include "platform/adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <utility>

namespace wm {

namespace {
// Vectors cross the wire as text in BOTH directions: written as a "{f,f,...}" literal bound as
// $n::real[], read back through vector::text and parsed here. pqxx has no portable float-array
// binding, and one shared text dialect keeps the mac and CI builds off pqxx's array readers
// entirely — the same reasoning that keeps day::text and epoch-ms bigints everywhere else.
// %.9g is float's max_digits10, so a stored vector round-trips bit-exact.
std::string arrayLiteral(const std::vector<float>& vector) {
  std::string text = "{";
  char number[32];
  for (std::size_t i = 0; i < vector.size(); ++i) {
    std::snprintf(number, sizeof number, "%.9g", static_cast<double>(vector[i]));
    if (i > 0) text += ',';
    text += number;
  }
  text += '}';
  return text;
}

std::vector<float> parseVector(const std::string& text) {
  std::vector<float> values;
  const char* cursor = text.c_str();
  if (*cursor == '{') ++cursor;
  while (*cursor != '\0' && *cursor != '}') {
    char* after = nullptr;
    const float value = std::strtof(cursor, &after);
    if (after == cursor) break;   // not a number — stop rather than spin on garbage
    values.push_back(value);
    cursor = after;
    if (*cursor == ',') ++cursor;
  }
  return values;
}

// Templated on the row type: pqxx names it row_ref on macOS and row on the CI's Linux build.
template <typename Row>
StoredEcho echoFrom(const Row& row) {
  return StoredEcho{
      LocalDate{row["trigger_day"].template as<std::string>()},
      LocalDate{row["match_day"].template as<std::string>()},
      {row["trigger_lo"].template as<int>(), row["trigger_hi"].template as<int>()},
      {row["match_lo"].template as<int>(), row["match_hi"].template as<int>()},
      row["score"].template as<float>()};
}
}

PgEchoRepository::PgEchoRepository(std::string connString) : connString_(std::move(connString)) {}

std::vector<EchoUser> PgEchoRepository::activeSince(std::uint64_t sinceMs) {
  // The nightly candidate list: distinct owners of a recently-touched page, carrying the email the
  // sweep hands to billing. A soft-closed account never comes up — its echoes stop being computed
  // the moment the grace period starts.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT DISTINCT p.user_id::text AS user_id, u.email::text AS email "
      "FROM journal_page p JOIN users u ON u.id = p.user_id "
      "WHERE u.deleted_at IS NULL "
      "AND (extract(epoch from p.updated_at) * 1000)::bigint > $1",
      static_cast<long long>(sinceMs));

  std::vector<EchoUser> users;
  users.reserve(rows.size());
  for (const auto& row : rows)
    users.push_back(EchoUser{UserId{row["user_id"].as<std::string>()},
                             Email{row["email"].as<std::string>()}});
  return users;
}

std::vector<PageText> PgEchoRepository::pagesNeedingVector(const UserId& user) {
  // Missing or stale: no vector row at all, or one computed from an older body (body_stamp_ms
  // records the page HLC ms the embedding was made from, so staleness is a plain bigint compare).
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT p.day::text AS day, p.body, p.stamp_ms "
      "FROM journal_page p LEFT JOIN journal_page_vector v USING (user_id, day) "
      "WHERE p.user_id = $1::uuid AND (v.day IS NULL OR v.body_stamp_ms < p.stamp_ms) "
      "ORDER BY p.day",
      user.str());

  std::vector<PageText> pages;
  pages.reserve(rows.size());
  for (const auto& row : rows)
    pages.push_back(PageText{LocalDate{row["day"].as<std::string>()},
                             row["body"].as<std::string>(),
                             row["stamp_ms"].as<std::uint64_t>()});
  return pages;
}

void PgEchoRepository::saveVector(const UserId& user, const LocalDate& day,
                                  const std::vector<float>& vector, std::uint64_t bodyStampMs) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO journal_page_vector (user_id, day, vector, body_stamp_ms) "
      "VALUES ($1::uuid, $2::date, $3::real[], $4) "
      "ON CONFLICT (user_id, day) DO UPDATE "
      "SET vector = EXCLUDED.vector, body_stamp_ms = EXCLUDED.body_stamp_ms, created_at = now()",
      user.str(), day.iso(), arrayLiteral(vector), static_cast<long long>(bodyStampMs));
  txn.commit();
}

std::vector<EchoCandidate> PgEchoRepository::corpusOf(const UserId& user) {
  // The whole comparison set in one read — vector and body side by side, so the finder's spans
  // point into exactly the text the vector was computed from.
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT day::text AS day, v.vector::text AS vector, p.body "
      "FROM journal_page_vector v JOIN journal_page p USING (user_id, day) "
      "WHERE user_id = $1::uuid ORDER BY day",
      user.str());

  std::vector<EchoCandidate> corpus;
  corpus.reserve(rows.size());
  for (const auto& row : rows)
    corpus.push_back(EchoCandidate{LocalDate{row["day"].as<std::string>()},
                                   parseVector(row["vector"].as<std::string>()),
                                   row["body"].as<std::string>()});
  return corpus;
}

std::vector<LocalDate> PgEchoRepository::triggersSince(const UserId& user, std::uint64_t sinceMs) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT day::text AS day FROM journal_page "
      "WHERE user_id = $1::uuid AND (extract(epoch from updated_at) * 1000)::bigint > $2 "
      "ORDER BY day",
      user.str(), static_cast<long long>(sinceMs));

  std::vector<LocalDate> days;
  days.reserve(rows.size());
  for (const auto& row : rows) days.push_back(LocalDate{row["day"].as<std::string>()});
  return days;
}

void PgEchoRepository::saveEcho(const UserId& user, const LocalDate& triggerDay,
                                const EchoMatch& match) {
  // Recomputing a day replaces its echo outright — spans, score, and the dismissed flag alike: a
  // re-found echo over an edited page is a NEW observation, not the one the reader waved away.
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "INSERT INTO journal_echo "
      "(user_id, trigger_day, match_day, trigger_lo, trigger_hi, match_lo, match_hi, score) "
      "VALUES ($1::uuid, $2::date, $3::date, $4, $5, $6, $7, $8) "
      "ON CONFLICT (user_id, trigger_day, match_day) DO UPDATE "
      "SET trigger_lo = EXCLUDED.trigger_lo, trigger_hi = EXCLUDED.trigger_hi, "
      "match_lo = EXCLUDED.match_lo, match_hi = EXCLUDED.match_hi, "
      "score = EXCLUDED.score, dismissed = false, created_at = now()",
      user.str(), triggerDay.iso(), match.matchDay.iso(),
      match.triggerSpan.first, match.triggerSpan.second,
      match.matchSpan.first, match.matchSpan.second, match.score);
  txn.commit();
}

std::vector<StoredEcho> PgEchoRepository::echoesFor(const UserId& user, const LocalDate& from,
                                                    const LocalDate& to) {
  pqxx::work txn{pgThreadConnection(connString_)};
  pqxx::result rows = txn.exec_params(
      "SELECT trigger_day::text AS trigger_day, match_day::text AS match_day, "
      "trigger_lo, trigger_hi, match_lo, match_hi, score "
      "FROM journal_echo "
      "WHERE user_id = $1::uuid AND trigger_day BETWEEN $2::date AND $3::date AND NOT dismissed "
      "ORDER BY trigger_day DESC",
      user.str(), from.iso(), to.iso());

  std::vector<StoredEcho> echoes;
  echoes.reserve(rows.size());
  for (const auto& row : rows) echoes.push_back(echoFrom(row));
  return echoes;
}

void PgEchoRepository::dismiss(const UserId& user, const LocalDate& triggerDay) {
  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec_params(
      "UPDATE journal_echo SET dismissed = true WHERE user_id = $1::uuid AND trigger_day = $2::date",
      user.str(), triggerDay.iso());
  txn.commit();
}

}
