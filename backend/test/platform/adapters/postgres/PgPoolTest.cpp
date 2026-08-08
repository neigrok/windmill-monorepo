#include "platform/adapters/postgres/PgPool.h"

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
#include <vector>

// The pool is the answer to a machine-level outage, so what it must guarantee is asserted here
// rather than inferred: it hands the same connection back out instead of opening another, it never
// opens more than its ceiling no matter how many threads ask at once, a borrower that arrives at a
// full pool waits for a return rather than opening one anyway, and a connection that comes back
// broken is dropped instead of pooled.
//
// Every case but the last needs a live Postgres and skips without WM_PG_TEST, exactly like the
// repository suites (RUNNING.md §7).
using namespace wm;

namespace {
const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";

std::string testConnString() { return pgTestPool()->connString(); }

int oneFromDatabase(PgLease& lease) {
  pqxx::work txn{*lease};
  return txn.exec1("SELECT 1")[0].as<int>();  // exec1, not query_value: CI pins libpqxx 7.x
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

  // The ceiling is the invariant. How many of the three ever got opened is up to the scheduler, so
  // asserting it reached exactly three would be asserting a race — but every one that was borrowed
  // must have come back, which is the leak check and is deterministic.
  CHECK(peak.load() <= static_cast<std::size_t>(3));
  CHECK(pool.openConnections() <= static_cast<std::size_t>(3));
  CHECK_EQ(pool.idleConnections(), pool.openConnections());
}

TEST(pg_pool_frees_the_slot_it_claimed_when_the_connection_cannot_be_opened) {
  PgPool pool{"postgresql://127.0.0.1:1/nothing-listens-here", 1,
              std::chrono::milliseconds{120}};

  // A failed connect must give its slot back, or one unreachable database permanently costs the
  // pool a connection and the ceiling ratchets down to zero.
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

  // A failed statement rolls the transaction back but leaves the connection usable, so the pool
  // keeps it — and with a ceiling of one, this second borrow only succeeds if it came back.
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
