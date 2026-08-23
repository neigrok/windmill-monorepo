#include "platform/adapters/postgres/PgPool.h"

#include "platform/adapters/postgres/PgOAuthRepository.h"
#include "platform/adapters/postgres/PgRetentionStore.h"
#include "platform/adapters/postgres/PgSweepMutex.h"

#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>

#include <vector>

// Every case but the unreachable-database one needs a live Postgres and skips without WM_PG_TEST.
using namespace wm;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

std::string testConnString() { return pgTestPool()->connString(); }

int oneFromDatabase(PgLease& lease) {
  pqxx::work txn{*lease};
  return txn.exec1("SELECT 1")[0].as<int>();  // exec1, not query_value: CI pins libpqxx 7.x
}

// A lock key nobody else on this database is using. Positive, so pg_locks reports it as classid 0 / objid key.
std::string testSweepKey() { return std::to_string(900'000'000 + static_cast<long>(getpid())); }

// How many sessions hold that key, asked from a DIFFERENT connection.
int advisoryLocksOn(PgPool& pool, const std::string& key) {
  PgLease lease{pool};
  pqxx::work txn{*lease};
  return txn.exec_params("SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' "
                         "AND classid = 0 AND objid::bigint = $1::bigint",
                         key)[0][0].as<int>();
}
}

TEST(pg_pool_reuses_one_connection_across_sequential_borrows) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  PgPool pool{testConnString()};

  for (int borrow = 0; borrow < 50; ++borrow) {
    PgLease lease{pool};
    CHECK_EQ(oneFromDatabase(lease), 1);
  }

  CHECK_EQ(pool.openConnections(), static_cast<std::size_t>(1));
  CHECK_EQ(pool.idleConnections(), static_cast<std::size_t>(1));
}

TEST(pg_pool_never_opens_more_than_its_ceiling_under_concurrent_borrowers) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  PgPool pool{testConnString(), 3};
  std::atomic<std::size_t> peak{0};

  std::vector<std::thread> borrowers;
  for (int worker = 0; worker < 12; ++worker)
    borrowers.emplace_back([&pool, &peak] {
      for (int borrow = 0; borrow < 10; ++borrow) {
        PgLease lease{pool};
        CHECK_EQ(oneFromDatabase(lease), 1);
        std::size_t seen = pool.openConnections();
        std::size_t was = peak.load();
        while (seen > was && !peak.compare_exchange_weak(was, seen)) {}
      }
    });
  for (std::thread& borrower : borrowers) borrower.join();

  // The ceiling is the invariant; how many were opened is up to the scheduler. Every borrow must have come back.
  CHECK(peak.load() <= static_cast<std::size_t>(3));
  CHECK(pool.openConnections() <= static_cast<std::size_t>(3));
  CHECK_EQ(pool.idleConnections(), pool.openConnections());
}

TEST(pg_pool_frees_the_slot_it_claimed_when_the_connection_cannot_be_opened) {
  PgPool pool{"postgresql://127.0.0.1:1/nothing-listens-here", 1,
              std::chrono::milliseconds{120}};

  // A failed connect must give its slot back, or one unreachable database ratchets the ceiling down to zero.
  for (int attempt = 0; attempt < 3; ++attempt) {
    bool threw = false;
    try {
      PgLease lease{pool};
    } catch (const std::exception&) {
      threw = true;
    }
    CHECK(threw);
    CHECK_EQ(pool.openConnections(), static_cast<std::size_t>(0));
  }
}

TEST(pg_pool_makes_a_borrower_wait_for_a_return_rather_than_opening_another) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  PgPool pool{testConnString(), 1};
  std::atomic<bool> gotOne{false};

  auto held = std::make_unique<PgLease>(pool);
  std::thread waiter([&pool, &gotOne] {
    PgLease lease{pool};
    gotOne = true;
  });

  std::this_thread::sleep_for(std::chrono::milliseconds{150});
  CHECK(!gotOne.load());          // the only connection is out, so the waiter is still waiting
  CHECK_EQ(pool.openConnections(), static_cast<std::size_t>(1));

  held.reset();                   // returning it is what releases the waiter
  waiter.join();
  CHECK(gotOne.load());
  CHECK_EQ(pool.openConnections(), static_cast<std::size_t>(1));
}

TEST(pg_pool_gives_up_rather_than_waiting_forever_on_a_leaked_connection) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  PgPool pool{testConnString(), 1, std::chrono::milliseconds{120}};

  PgLease leaked{pool};
  bool threw = false;
  try {
    PgLease queued{pool};
  } catch (const std::runtime_error&) {
    threw = true;
  }

  CHECK(threw);
  CHECK_EQ(pool.openConnections(), static_cast<std::size_t>(1));
}

TEST(pg_pool_drops_a_broken_connection_instead_of_pooling_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  PgPool pool{testConnString(), 2};

  {
    PgLease lease{pool};
    CHECK_EQ(oneFromDatabase(lease), 1);
    lease->close();
  }

  CHECK_EQ(pool.openConnections(), static_cast<std::size_t>(0));
  CHECK_EQ(pool.idleConnections(), static_cast<std::size_t>(0));

  PgLease fresh{pool};             // the freed slot is what lets the next borrower open a live one
  CHECK_EQ(oneFromDatabase(fresh), 1);
}

TEST(pg_pool_returns_the_connection_when_the_transaction_throws) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  PgPool pool{testConnString(), 1};

  try {
    PgLease lease{pool};
    pqxx::work txn{*lease};
    txn.exec("SELECT * FROM a_table_that_does_not_exist");
  } catch (const pqxx::sql_error&) {
  }

  // A failed statement rolls the transaction back but leaves the connection usable, so the pool keeps it.
  PgLease next{pool};
  CHECK_EQ(oneFromDatabase(next), 1);
  CHECK_EQ(pool.openConnections(), static_cast<std::size_t>(1));
}

TEST(pg_pool_ceiling_is_twenty_by_default) {
  PgPool pool{"postgresql://localhost/windmill-never-opened"};
  CHECK_EQ(PgPool::kDefaultMaxConnections, static_cast<std::size_t>(20));
  CHECK_EQ(pool.maxConnections(), static_cast<std::size_t>(20));
  CHECK_EQ(pool.openConnections(), static_cast<std::size_t>(0));  // and it connects lazily
}

TEST(pg_sweep_mutex_hands_the_lock_back_on_the_connection_that_took_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  auto pool = std::make_shared<PgPool>(testConnString(), 4);
  const std::string key = testSweepKey();
  PgSweepMutex mutex{pool, key, "test sweep"};

  bool ran = false;
  std::unique_ptr<PgLease> churn;
  const bool held = mutex.underSweepLock([&] {
    ran = true;
    CHECK_EQ(advisoryLocksOn(*pool, key), 1);
    // The pass borrows and KEEPS the borrow past the end of the pass, so the connection the pool hands out next is provably not the one the lock is on.
    churn = std::make_unique<PgLease>(*pool);
    CHECK_EQ(oneFromDatabase(*churn), 1);
  });

  CHECK(held);
  CHECK(ran);
  CHECK_EQ(advisoryLocksOn(*pool, key), 0);
  churn.reset();
}

TEST(pg_sweep_mutex_answers_false_without_running_a_pass_someone_else_is_already_running) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  auto pool = std::make_shared<PgPool>(testConnString(), 4);
  const std::string key = testSweepKey();
  PgSweepMutex mine{pool, key, "test sweep"};
  PgSweepMutex theirs{pool, key, "test sweep"};   // a second process, as far as Postgres can tell

  bool theirsRan = false;
  bool theirsHeld = true;
  const bool mineHeld = mine.underSweepLock([&] {
    theirsHeld = theirs.underSweepLock([&] { theirsRan = true; });
  });

  CHECK(mineHeld);
  CHECK_FALSE(theirsHeld);
  CHECK_FALSE(theirsRan);
  CHECK_EQ(advisoryLocksOn(*pool, key), 0);
}

TEST(pg_sweep_mutex_hands_the_lock_back_when_the_pass_throws) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  auto pool = std::make_shared<PgPool>(testConnString(), 4);
  const std::string key = testSweepKey();
  PgSweepMutex mutex{pool, key, "test sweep"};

  bool threw = false;
  try {
    mutex.underSweepLock([] { throw std::runtime_error("the batch blew up"); });
  } catch (const std::runtime_error&) {
    threw = true;
  }

  CHECK(threw);
  CHECK_EQ(advisoryLocksOn(*pool, key), 0);
}

TEST(pg_sweep_mutex_poisons_the_connection_when_the_unlock_itself_fails) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  auto pool = std::make_shared<PgPool>(testConnString(), 4);
  const std::string key = testSweepKey();

  // A key expression that stops resolving mid-pass: a live connection whose unlock STATEMENT fails. Swallowing that would hand a still-locked connection back to the pool.
  {
    PgLease setup{*pool};
    pqxx::work txn{*setup};
    txn.exec("DROP TABLE IF EXISTS wm_sweep_key_probe");
    txn.exec("CREATE TABLE wm_sweep_key_probe (k bigint)");
    txn.exec("INSERT INTO wm_sweep_key_probe VALUES (" + key + ")");
    txn.commit();
  }
  PgSweepMutex mutex{pool, "(SELECT k FROM wm_sweep_key_probe)", "test sweep"};

  const bool held = mutex.underSweepLock([&] {
    CHECK_EQ(advisoryLocksOn(*pool, key), 1);
    PgLease saboteur{*pool};
    pqxx::work txn{*saboteur};
    txn.exec("DROP TABLE wm_sweep_key_probe");
    txn.commit();
  });

  // Postgres releases a session-scoped lock with the session.
  CHECK(held);
  CHECK_EQ(advisoryLocksOn(*pool, key), 0);
}

// Every row these plant is prefixed w2-platform / a fixed uuid and deleted again on the way in.
namespace {
const std::string kRetentionUser = "4b2f0000-0000-4000-8000-00000000c0de";
const std::string kRetentionEmail = "w2-platform-retention@example.com";

void seedRetentionFixture() {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  w.exec("INSERT INTO users (id, email) VALUES ('" + kRetentionUser + "', '" + kRetentionEmail +
         "') ON CONFLICT (id) DO NOTHING");
  w.exec("DELETE FROM oauth_tokens WHERE client_id LIKE 'w2-platform-%'");
  w.exec("DELETE FROM oauth_codes WHERE client_id LIKE 'w2-platform-%'");
  w.exec("DELETE FROM oauth_grants WHERE client_id LIKE 'w2-platform-%'");
  w.exec("DELETE FROM oauth_clients WHERE client_id LIKE 'w2-platform-%'");
  w.exec("DELETE FROM events WHERE session_key LIKE 'w2-platform-%'");
  w.exec("DELETE FROM feedback WHERE message LIKE 'w2-platform-%'");
  w.exec("DELETE FROM server_errors WHERE path LIKE '/w2-platform-%'");
  w.commit();
}

int countWhere(const std::string& sql) {
  PgLease c{*pgTestPool()};
  pqxx::work w{*c};
  return w.exec("SELECT count(*)::int FROM " + sql)[0][0].as<int>();
}
}

TEST(pg_oauth_rotation_spends_the_row_and_leaves_a_tombstone_reuse_is_recognised_by) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  seedRetentionFixture();
  PgOAuthRepository repo{pgTestPool()};
  const UnixMs now = 1'700'000'000'000;
  repo.insertToken("w2-platform-access", "w2-platform-refresh",
                   StoredToken{"w2-platform-client", UserId{kRetentionUser}, "https://mcp.example/mcp",
                               "roadmap:write", now + 3'600'000},
                   now + 86'400'000);

  const RefreshRotation first = repo.rotateRefreshToken("w2-platform-refresh", now);
  CHECK(first.outcome == RefreshOutcome::rotated);
  REQUIRE(first.grant.has_value());
  CHECK_EQ(first.grant->clientId, std::string("w2-platform-client"));
  CHECK_EQ(first.grant->user, UserId{kRetentionUser});
  CHECK_EQ(first.grant->scope, std::string("roadmap:write"));
  CHECK_FALSE(repo.findAccessToken("w2-platform-access")->expiresAt > now);

  const RefreshRotation replay = repo.rotateRefreshToken("w2-platform-refresh", now + 1000);
  CHECK(replay.outcome == RefreshOutcome::reused);
  REQUIRE(replay.grant.has_value());
  CHECK_EQ(replay.grant->clientId, std::string("w2-platform-client"));
  CHECK_EQ(replay.spentMs, now);

  const RefreshRotation stranger = repo.rotateRefreshToken("w2-platform-never-issued", now);
  CHECK(stranger.outcome == RefreshOutcome::unknown);
  CHECK_FALSE(stranger.grant.has_value());

  seedRetentionFixture();
}

TEST(pg_retention_takes_what_is_past_its_window_and_leaves_everything_else) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  seedRetentionFixture();
  const UnixMs now = 1'700'000'000'000;
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    // A TEN-YEAR window on purpose: on a shared developer database only the rows planted here are old enough to die.
    w.exec("INSERT INTO events (ts, session_key, name, props) VALUES "
           "(now() - interval '4000 days', 'w2-platform-old', 'page_view', '{}'::jsonb), "
           "(now() - interval '1 day', 'w2-platform-new', 'page_view', '{}'::jsonb)");
    w.exec("INSERT INTO feedback (ts, session_key, message) VALUES "
           "(now() - interval '4000 days', 'w2-platform-old', 'w2-platform-old note'), "
           "(now() - interval '1 day', 'w2-platform-new', 'w2-platform-new note')");
    w.exec("INSERT INTO server_errors (ts, method, path, status, message) VALUES "
           "(now() - interval '4000 days', 'GET', '/w2-platform-old', 500, 'boom'), "
           "(now() - interval '1 day', 'GET', '/w2-platform-new', 500, 'boom')");
    w.exec_params("INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, "
                  "code_challenge, resource, scope, expires_ms) VALUES "
                  "('w2-platform-code-dead', 'w2-platform-client', $1::uuid, 'https://a/cb', 'c', 'r', '', $2), "
                  "('w2-platform-code-live', 'w2-platform-client', $1::uuid, 'https://a/cb', 'c', 'r', '', $3)",
                  kRetentionUser, static_cast<long long>(now - 1000), static_cast<long long>(now + 600'000));
    w.exec_params("INSERT INTO oauth_tokens (token_hash, refresh_hash, client_id, user_id, resource, "
                  "scope, expires_ms, refresh_expires_ms) VALUES "
                  "('w2-platform-tok-dead', 'w2-platform-ref-dead', 'w2-platform-client', $1::uuid, 'r', '', $2, $2), "
                  "('w2-platform-tok-live', 'w2-platform-ref-live', 'w2-platform-client', $1::uuid, 'r', '', $2, $3)",
                  kRetentionUser, static_cast<long long>(now - 1000), static_cast<long long>(now + 600'000));
    w.exec("INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES "
           "('w2-platform-orphan', '{\"https://a/cb\"}'::text[], '', now() - interval '4000 days'), "
           "('w2-platform-attached', '{\"https://a/cb\"}'::text[], '', now() - interval '4000 days'), "
           "('w2-platform-young', '{\"https://a/cb\"}'::text[], '', now())");
    w.exec_params("INSERT INTO oauth_grants (user_id, client_id, granted_ms, last_used_ms, scope) "
                  "VALUES ($1::uuid, 'w2-platform-attached', 1, 1, '')",
                  kRetentionUser);
    w.commit();
  }
  const int usersBefore = countWhere("users");

  RetentionWindows windows;
  windows.eventDays = 3650;
  windows.feedbackDays = 3650;
  windows.serverErrorDays = 3650;
  PgRetentionStore store{pgTestPool()};
  const RetentionReport report = store.purge(windows, now);

  // The counts are >= because a developer database carries other people's old rows; what each planted row DID is asserted exactly below.
  CHECK(report.ran);
  CHECK(report.events >= 1);
  CHECK(report.feedback >= 1);
  CHECK(report.serverErrors >= 1);
  CHECK(report.oauthCodes >= 1);
  CHECK(report.oauthTokens >= 1);
  CHECK(report.oauthClients >= 1);
  CHECK_EQ(countWhere("events WHERE session_key = 'w2-platform-new'"), 1);
  CHECK_EQ(countWhere("events WHERE session_key = 'w2-platform-old'"), 0);
  CHECK_EQ(countWhere("feedback WHERE message = 'w2-platform-new note'"), 1);
  CHECK_EQ(countWhere("server_errors WHERE path = '/w2-platform-new'"), 1);
  CHECK_EQ(countWhere("oauth_codes WHERE code_hash = 'w2-platform-code-live'"), 1);
  CHECK_EQ(countWhere("oauth_tokens WHERE token_hash = 'w2-platform-tok-live'"), 1);
  CHECK_EQ(countWhere("oauth_clients WHERE client_id = 'w2-platform-attached'"), 1);
  CHECK_EQ(countWhere("oauth_clients WHERE client_id = 'w2-platform-young'"), 1);
  CHECK_EQ(countWhere("oauth_clients WHERE client_id = 'w2-platform-orphan'"), 0);
  CHECK_EQ(countWhere("users"), usersBefore);

  // A rotation tombstone is swept on its OWN short window, not the thirty-day refresh lifetime it still carries.
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec_params("INSERT INTO oauth_tokens (token_hash, refresh_hash, client_id, user_id, resource, "
                  "scope, expires_ms, refresh_expires_ms, rotated_ms) VALUES "
                  "('w2-platform-tomb-old', 'w2-platform-ref-tomb-old', 'w2-platform-client', $1::uuid, "
                  "'r', '', $2, $3, $4), "
                  "('w2-platform-tomb-new', 'w2-platform-ref-tomb-new', 'w2-platform-client', $1::uuid, "
                  "'r', '', $2, $3, $5)",
                  kRetentionUser, static_cast<long long>(now + 600'000),
                  static_cast<long long>(now + 30ll * 24 * 60 * 60 * 1000),
                  static_cast<long long>(now - static_cast<long long>(OAuthPolicy::spentRefreshTombstoneMs) - 1000),
                  static_cast<long long>(now - 1000));
    w.commit();
  }
  const RetentionReport tombstones = store.purge(windows, now);
  CHECK(tombstones.oauthTokens >= 1);
  CHECK_EQ(countWhere("oauth_tokens WHERE token_hash = 'w2-platform-tomb-old'"), 0);
  CHECK_EQ(countWhere("oauth_tokens WHERE token_hash = 'w2-platform-tomb-new'"), 1);

  // A window of zero is an operator saying keep it all, and the table is skipped whole.
  RetentionWindows kept;
  kept.eventDays = 0;
  kept.feedbackDays = 0;
  kept.serverErrorDays = 0;
  {
    PgLease c{*pgTestPool()};
    pqxx::work w{*c};
    w.exec("INSERT INTO events (ts, session_key, name, props) VALUES "
           "(now() - interval '4000 days', 'w2-platform-old', 'page_view', '{}'::jsonb)");
    w.commit();
  }
  const RetentionReport second = store.purge(kept, now);
  CHECK_EQ(second.events, 0);
  CHECK_EQ(second.feedback, 0);
  CHECK_EQ(second.serverErrors, 0);
  CHECK_EQ(countWhere("events WHERE session_key = 'w2-platform-old'"), 1);

  seedRetentionFixture();
}
