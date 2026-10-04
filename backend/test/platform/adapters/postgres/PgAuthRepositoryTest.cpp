#include "platform/adapters/postgres/PgAuthRepository.h"

#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

// Opt-in integration test: needs a live local Postgres with the schema applied and WM_PG_TEST set; otherwise every
// case reports skip. It seeds its own rows: what the bulk revocations and an account's delete answer is every digest
// they dropped, which the live sync sockets those sessions opened are closed by.
using namespace wm;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

const std::string kSam = "66666666-6666-4666-8666-666666666666";
const std::string kEve = "77777777-7777-4777-8777-777777777777";
const std::string kFold = "88888888-8888-4888-8888-888888888888";

void reset() {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  w.exec("DELETE FROM sessions WHERE token_hash LIKE 'pgtest-%'");
  w.exec("INSERT INTO users (id, email) VALUES ('" + kSam + "', 'sam-pgtest@example.com'), ('" + kEve + "', 'eve-pgtest@example.com'), ('" +
         kFold + "', 'fold-pgtest@example.com') ON CONFLICT (id) DO NOTHING");
  w.commit();
}

std::vector<std::string> sorted(std::vector<std::string> digests) {
  std::sort(digests.begin(), digests.end());
  return digests;
}
}

TEST(pg_auth_bulk_revocations_answer_every_digest_they_dropped_and_only_the_accounts_own) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAuthRepository repo{pgTestPool()};
  for (const std::string digest : {"pgtest-sam-1", "pgtest-sam-2", "pgtest-sam-3"}) repo.insertSession(digest, UserId{kSam}, 9'000'000'000'000, "", "", 1);
  repo.insertSession("pgtest-eve-1", UserId{kEve}, 9'000'000'000'000, "", "", 1);

  CHECK_EQ(sorted(repo.revokeSessionsExcept(UserId{kSam}, "pgtest-sam-2")), (std::vector<std::string>{"pgtest-sam-1", "pgtest-sam-3"}));
  CHECK(repo.findSession("pgtest-sam-2").has_value());
  CHECK_EQ(repo.revokeAllSessions(UserId{kSam}), (std::vector<std::string>{"pgtest-sam-2"}));
  CHECK(repo.revokeAllSessions(UserId{kSam}).empty());
  CHECK(repo.findSession("pgtest-eve-1").has_value());
}

TEST(pg_auth_deleting_an_account_answers_every_session_its_row_took_with_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAuthRepository repo{pgTestPool()};
  for (const std::string digest : {"pgtest-fold-1", "pgtest-fold-2"}) repo.insertSession(digest, UserId{kFold}, 9'000'000'000'000, "", "", 1);
  repo.insertSession("pgtest-eve-1", UserId{kEve}, 9'000'000'000'000, "", "", 1);

  CHECK_EQ(sorted(repo.deleteUser(UserId{kFold})), (std::vector<std::string>{"pgtest-fold-1", "pgtest-fold-2"}));
  CHECK_FALSE(repo.findUserById(UserId{kFold}).has_value());
  CHECK_FALSE(repo.findSession("pgtest-fold-1").has_value());
  CHECK(repo.findSession("pgtest-eve-1").has_value());
  CHECK(repo.deleteUser(UserId{kFold}).empty());
}

TEST(pg_auth_refresh_answers_whether_the_session_row_was_updated) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgAuthRepository repo{pgTestPool()};
  repo.insertSession("pgtest-refresh", UserId{kSam}, 9'000'000'000'000, "", "", 1);
  CHECK(repo.refreshSession("pgtest-refresh", 9'000'000'000'001, 2, "", ""));
  CHECK_FALSE(repo.refreshSession("pgtest-no-session", 9'000'000'000'001, 2, "", ""));
  REQUIRE(repo.findSession("pgtest-refresh").has_value());
  CHECK_EQ(repo.findSession("pgtest-refresh")->expiresAt, 9'000'000'000'001ULL);
}
