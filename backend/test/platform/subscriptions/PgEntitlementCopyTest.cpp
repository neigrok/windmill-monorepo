#include "platform/subscriptions/PgEntitlementCopy.h"

#include "test/PgTestPool.h"
#include "test/platform/subscriptions/FeedFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <string>

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
