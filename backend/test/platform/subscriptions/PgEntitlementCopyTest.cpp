#include "platform/subscriptions/PgEntitlementCopy.h"

#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/application/Entitlements.h"
#include "test/PgTestPool.h"
#include "test/platform/Fakes.h"
#include "test/platform/subscriptions/FeedFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>

// Opt-in integration cases: a live Postgres built by db/schema.sql and WM_PG_TEST set (RUNNING.md §7); otherwise each
// reports skip.
using namespace wm;
using namespace wm::subscriptions;
using namespace wm::subscriptions::test;

namespace {
void sql(const std::string& statement) {
  PgLease lease{*pgTestPool()};
  pqxx::work txn{*lease};
  txn.exec(statement);
  txn.commit();
}

std::string rowsAsText() {
  PgLease lease{*pgTestPool()};
  pqxx::read_transaction txn{*lease};
  const pqxx::result rows = txn.exec(
      "SELECT account_id::text, seq, coalesce(production_access_until::text, '-') FROM account_entitlements "
      "ORDER BY account_id");
  std::string text;
  for (const auto row : rows)
    text += row[0].as<std::string>() + " seq=" + row[1].as<std::string>() + " production=" + row[2].as<std::string>() + "\n";
  return text;
}

// The chosen entries of a recorded page through the copy, in a page transaction that leaves the cursor where it is.
void consume(PgEntitlementCopy& copy, const char* page, std::initializer_list<Seq> seqs) {
  const FeedPage read{contractExample("feed.json", page)["body"]};
  const auto txn = copy.begin(copy.cursor(), false);
  for (const FeedEntry& entry : read.entries)
    for (const Seq seq : seqs)
      if (entry.seq == seq) copy.consume(*txn, entry);
  txn->commit();
}
}

TEST(pg_entitlement_copy_writes_no_row_for_an_account_this_backend_does_not_hold_and_erasure_takes_the_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  sql("DELETE FROM account_entitlements");
  sql("DELETE FROM users WHERE id IN ('9387ec65-ab17-4b8c-b145-fd0d622966db', 'c806aea4-76c0-4868-acbc-3aa7db2b8dd0')");
  sql("INSERT INTO users (id, email) VALUES ('3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61', 'follow-3f6c2a1e@example.com') "
      "ON CONFLICT (id) DO NOTHING");
  PgEntitlementCopy copy{pgTestPool()};

  consume(copy, "from_zero", {1, 2, 3, 4, 5, 6});
  CHECK_EQ(rowsAsText(), std::string("3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=3 production=1799056800000\n"));
  CHECK_FALSE(copy.find(UserId{"9387ec65-ab17-4b8c-b145-fd0d622966db"}).has_value());

  sql("DELETE FROM users WHERE id = '3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61'");
  CHECK_EQ(rowsAsText(), std::string(""));
  CHECK_FALSE(copy.find(UserId{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"}).has_value());
  CHECK_FALSE(copy.find(UserId{"not-an-account"}).has_value());
}

TEST(pg_entitlement_copy_never_takes_a_row_back_to_an_older_entry_but_a_rebuild_starts_from_empty) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  sql("DELETE FROM account_entitlements");
  sql("UPDATE subscription_feed_cursor SET epoch = NULL, seq = 0");
  sql("INSERT INTO users (id, email) VALUES ('3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61', 'follow-3f6c2a1e@example.com') "
      "ON CONFLICT (id) DO NOTHING");
  PgEntitlementCopy copy{pgTestPool()};
  CHECK_EQ(copy.cursor(), FeedCursor{});

  consume(copy, "account_erased", {26});
  consume(copy, "from_zero", {3});
  CHECK_EQ(rowsAsText(), std::string("3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=26 production=-\n"));
  CHECK_EQ(copy.find(UserId{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"})->body, entitlementExample("never_subscribed"));

  // A rebuild that never commits leaves the old copy whole.
  {
    const auto txn = copy.begin(FeedCursor{"2dd74022-4cb9-42f8-8746-0a186269b54e", 3}, true);
    CHECK_EQ(rowsAsText(), std::string("3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=26 production=-\n"));
  }
  CHECK_EQ(rowsAsText(), std::string("3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=26 production=-\n"));
  CHECK_EQ(copy.cursor(), FeedCursor{});

  {
    const auto txn = copy.begin(FeedCursor{"2dd74022-4cb9-42f8-8746-0a186269b54e", 3}, true);
    CHECK_EQ(txn->cursor(), FeedCursor{});
    CHECK(txn->rebuilding());
    CHECK_EQ(txn->target(), (FeedCursor{"2dd74022-4cb9-42f8-8746-0a186269b54e", 3}));
    const FeedPage page{contractExample("feed.json", "from_zero")["body"]};
    copy.consume(*txn, page.entries[2]);
    txn->commit();
  }
  CHECK_EQ(rowsAsText(), std::string("3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=3 production=1799056800000\n"));
  CHECK_EQ(copy.find(UserId{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"})->body, entitlementExample("active"));
  CHECK_EQ(copy.cursor(), (FeedCursor{"2dd74022-4cb9-42f8-8746-0a186269b54e", 3}));
}

TEST(pg_entitlement_copy_a_rebuild_and_the_final_erasure_of_an_account_it_holds_both_complete) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  sql("DELETE FROM account_entitlements");
  sql("UPDATE subscription_feed_cursor SET epoch = NULL, seq = 0");
  sql("DELETE FROM users WHERE id IN ('3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61', '9387ec65-ab17-4b8c-b145-fd0d622966db', "
      "'c806aea4-76c0-4868-acbc-3aa7db2b8dd0')");
  sql("INSERT INTO users (id, email, deleted_at, closes_at) VALUES ('9387ec65-ab17-4b8c-b145-fd0d622966db', "
      "'copy-9387ec65@example.com', now() - interval '40 days', now() - interval '1 day')");
  PgEntitlementCopy copy{pgTestPool()};
  consume(copy, "from_zero", {6});
  CHECK_EQ(rowsAsText(), std::string("9387ec65-ab17-4b8c-b145-fd0d622966db seq=6 production=1799236800000\n"));

  // The rebuild has emptied the copy when the account's erasure begins, and writes the account's row again after.
  PgAuthRepository accounts{pgTestPool()};
  std::string erased = "not run";
  {
    const auto txn = copy.begin(FeedCursor{"2dd74022-4cb9-42f8-8746-0a186269b54e", 6}, true);
    std::thread eraser([&] {
      const auto now = std::chrono::system_clock::now().time_since_epoch();
      try {
        erased = accounts.eraseAccount(UserId{"9387ec65-ab17-4b8c-b145-fd0d622966db"},
                                       std::chrono::duration_cast<std::chrono::milliseconds>(now).count())
                     ? "erased"
                     : "nothing to erase";
      } catch (const std::exception& error) {
        erased = std::string("threw: ") + error.what();
      }
    });
    bool waiting = false;
    for (int look = 0; look < 100 && !waiting; ++look) {
      PgLease lease{*pgTestPool()};
      pqxx::read_transaction probe{*lease};
      waiting = probe.exec("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                           "AND wait_event_type = 'Lock'")[0][0].as<int>() > 0;
      if (!waiting) std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    CHECK(waiting);
    for (const FeedEntry& entry : FeedPage{contractExample("feed.json", "from_zero")["body"]}.entries)
      copy.consume(*txn, entry);
    txn->commit();
    eraser.join();
  }

  CHECK_EQ(erased, std::string("erased"));
  CHECK_EQ(rowsAsText(), std::string());
  CHECK_EQ(copy.cursor(), (FeedCursor{"2dd74022-4cb9-42f8-8746-0a186269b54e", 6}));
}

// With the subscription service down nothing follows its feed, and Windmill One still answers from the row the feed last
// wrote, lapsing on time with nothing running (INV-10, INV-3).
TEST(pg_entitlement_copy_answers_windmill_one_with_the_service_down_and_lapses_by_the_clock) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  sql("DELETE FROM account_entitlements");
  sql("INSERT INTO users (id, email) VALUES ('3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61', 'follow-3f6c2a1e@example.com') "
      "ON CONFLICT (id) DO NOTHING");
  PgEntitlementCopy copy{pgTestPool()};
  consume(copy, "from_zero", {3});
  fake::FakeClock clock;
  fake::FakeAiUsageRepository usage;
  const Entitlements entitlements{copy, clock, usage};
  const UserId buyer{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"};

  std::string seen;
  for (const UnixMs at : {1'799'056'799'999ULL, 1'799'056'800'000ULL}) {
    clock.now = at;
    seen += std::to_string(at) + (entitlements.hasWindmillOne(buyer, "follow-3f6c2a1e@example.com") ? " one\n" : " free\n");
  }
  CHECK_EQ(seen, std::string("1799056799999 one\n1799056800000 free\n"));
  CHECK_FALSE(entitlements.hasWindmillOne(UserId{"9387ec65-ab17-4b8c-b145-fd0d622966db"}, "claimant@example.com"));
}

// Access reads the row's columns, not its body (db/schema.sql): an operator who clears production_access_until ends that
// access with the body still saying otherwise, and a column the body does not echo grants until it lapses.
TEST(pg_entitlement_copy_reads_access_from_the_row_s_columns_and_shows_its_body) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  sql("DELETE FROM account_entitlements");
  sql("INSERT INTO users (id, email) VALUES ('3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61', 'follow-3f6c2a1e@example.com') "
      "ON CONFLICT (id) DO NOTHING");
  PgEntitlementCopy copy{pgTestPool()};
  consume(copy, "from_zero", {3});
  fake::FakeClock clock;
  clock.now = 1'796'378'400'000;
  fake::FakeAiUsageRepository usage;
  const Entitlements entitlements{copy, clock, usage};
  const UserId buyer{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"};
  const auto answer = [&] { return entitlements.hasWindmillOne(buyer, "follow-3f6c2a1e@example.com") ? "one\n" : "free\n"; };

  std::string seen = answer();
  sql("UPDATE account_entitlements SET production_access_until = NULL");
  seen += answer();
  CHECK_EQ(copy.find(buyer)->body, entitlementExample("active"));
  {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec("UPDATE account_entitlements SET production_access_until = 1800000000000, entitlement = $1::json",
             pqxx::params{dump(entitlementExample("never_subscribed"))});
    txn.commit();
  }
  seen += answer();
  CHECK_EQ(seen, std::string("one\nfree\none\n"));
  sql("DELETE FROM account_entitlements");
}
