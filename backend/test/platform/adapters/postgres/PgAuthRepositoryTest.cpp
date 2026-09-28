#include "platform/adapters/postgres/PgAuthRepository.h"

#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

// Opt-in integration test: needs a live local Postgres with the schema applied and WM_PG_TEST set; otherwise every
// case reports skip. It seeds its own rows: what the bulk revocations answer is every digest they dropped, which the
// live sync sockets those sessions opened are closed by.
using namespace wm;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

const std::string kSam = "66666666-6666-4666-8666-666666666666";
const std::string kEve = "77777777-7777-4777-8777-777777777777";

void reset() {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  w.exec("DELETE FROM sessions WHERE token_hash LIKE 'pgtest-%'");
  w.exec("INSERT INTO users (id, email) VALUES ('" + kSam + "', 'sam-pgtest@example.com'), ('" + kEve + "', 'eve-pgtest@example.com') "
         "ON CONFLICT (id) DO NOTHING");
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
