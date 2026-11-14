#include "platform/subscriptions/FeedFollower.h"

#include "platform/subscriptions/PgEntitlementCopy.h"
#include "test/PgTestPool.h"
#include "test/platform/subscriptions/FeedFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// Opt-in integration cases: a live Postgres built by db/schema.sql and WM_PG_TEST set (RUNNING.md §7); otherwise each
// reports skip. The fake feed serves the golden pages of packages/api-contract/subscriptions/feed.json.
using namespace wm;
using namespace wm::subscriptions;
using namespace wm::subscriptions::test;
using namespace std::chrono_literals;

namespace {
// An empty copy that never read the feed, beside the three accounts the fixture ledger names.
void freshCopy() {
  PgLease lease{*pgTestPool()};
  pqxx::work txn{*lease};
  txn.exec("DELETE FROM account_entitlements");
  txn.exec("UPDATE subscription_feed_cursor SET epoch = NULL, seq = 0");
  txn.exec("INSERT INTO users (id, email) VALUES "
           "('3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61', 'follow-3f6c2a1e@example.com'), "
           "('9387ec65-ab17-4b8c-b145-fd0d622966db', 'follow-9387ec65@example.com'), "
           "('c806aea4-76c0-4868-acbc-3aa7db2b8dd0', 'follow-c806aea4@example.com') ON CONFLICT (id) DO NOTHING");
  txn.commit();
}

std::string copyAsText() {
  PgLease lease{*pgTestPool()};
  pqxx::read_transaction txn{*lease};
  const pqxx::result cursor = txn.exec("SELECT coalesce(epoch, '-'), seq FROM subscription_feed_cursor");
  std::string text = "cursor " + cursor[0][0].as<std::string>() + "/" + cursor[0][1].as<std::string>() + "\n";
  const pqxx::result rows = txn.exec(
      "SELECT account_id::text, seq, coalesce(production_access_until::text, '-'), "
      "coalesce(sandbox_access_until::text, '-') FROM account_entitlements ORDER BY account_id");
  for (const auto row : rows)
    text += row[0].as<std::string>() + " seq=" + row[1].as<std::string>() + " production=" + row[2].as<std::string>() +
            " sandbox=" + row[3].as<std::string>() + "\n";
  return text;
}

std::string nameOf(FollowStep step) {
  switch (step) {
    case FollowStep::applied: return "applied";
    case FollowStep::caughtUp: return "caughtUp";
    case FollowStep::behind: return "behind";
    case FollowStep::rebuilt: return "rebuilt";
    case FollowStep::unavailable: return "unavailable";
    case FollowStep::failed: return "failed";
    case FollowStep::overtaken: return "overtaken";
  }
  return "?";
}

struct Reports : FailureReporter {
  std::vector<std::string> lines;
  std::vector<std::string> requestIds;
  void report(const std::string& kind, const std::string& where, const std::string& detail) override {
    lines.push_back(kind + " " + where + " " + detail);
    requestIds.push_back(currentWriteRequestId());
  }
};

// Every `subscription.follow` completion line, as outcome/level, for as long as it lives.
class FollowLines {
public:
  FollowLines() {
    installWriteSink([this](const WriteCompletion& line) {
      if (line.operation != "subscription.follow") return;
      const char* level = line.severity == WriteSeverity::error  ? "error"
                          : line.severity == WriteSeverity::warn ? "warn"
                          : line.severity == WriteSeverity::info ? "info"
                                                                 : "debug";
      std::lock_guard lock{mutex_};
      lines_.push_back(line.outcome + "/" + level + " " + line.product + " " + line.door);
      requestIds_.push_back(line.requestId);
    });
  }
  ~FollowLines() { installWriteSink({}); }

  std::vector<std::string> taken() {
    std::lock_guard lock{mutex_};
    return lines_;
  }

  // Whether any line was written under one of these request ids: a report that took a read's Issue.
  bool sharesARequestWith(const std::vector<std::string>& ids) {
    std::lock_guard lock{mutex_};
    for (const std::string& id : ids)
      if (id.empty() || std::find(requestIds_.begin(), requestIds_.end(), id) != requestIds_.end()) return true;
    return false;
  }

private:
  std::mutex mutex_;
  std::vector<std::string> lines_;
  std::vector<std::string> requestIds_;
};
}

TEST(pg_subscription_follow_an_incremental_follow_equals_a_rebuild_from_zero) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble", "older_period_refunded",
              "account_erased", "caught_up"});
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  FollowLines lines;
  FeedFollower follower{feed, copy, {}, reports};

  std::string steps;
  for (int read = 0; read < 7; ++read) steps += nameOf(follower.follow()) + " ";
  CHECK_EQ(steps, std::string("applied applied applied applied applied applied caughtUp "));
  CHECK_EQ(feed.reads(), (std::vector<std::pair<Seq, int>>{{0, 500}, {6, 500}, {13, 500}, {17, 500}, {21, 500},
                                                            {25, 500}, {26, 500}}));
  const std::string followed = copyAsText();
  CHECK_EQ(followed, std::string(
      "cursor c09a3ab3-2732-4415-ba88-825ff868cf13/26\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=26 production=- sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=15 production=- sandbox=-\n"
      "c806aea4-76c0-4868-acbc-3aa7db2b8dd0 seq=13 production=- sandbox=1796742600000\n"));
  CHECK_EQ(copy.find(UserId{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"})->body, entitlementExample("never_subscribed"));
  CHECK_EQ(copy.find(UserId{"9387ec65-ab17-4b8c-b145-fd0d622966db"})->body, entitlementExample("revoked"));
  CHECK_EQ(copy.find(UserId{"c806aea4-76c0-4868-acbc-3aa7db2b8dd0"})->body, entitlementExample("sandbox_active"));

  // The same ledger, restored whole under a new epoch: the follower reads it again from zero and replaces the copy.
  for (const char* name : {"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble",
                           "older_period_refunded", "account_erased", "caught_up"})
    feed.serve(contractExample("feed.json", name)["request"]["after"].asUInt64(), restored(name, 26));
  CHECK_EQ(nameOf(follower.follow()), std::string("rebuilt"));

  std::string rebuilt = followed;
  rebuilt.replace(rebuilt.find("c09a3ab3-2732-4415-ba88-825ff868cf13"), 36, "2dd74022-4cb9-42f8-8746-0a186269b54e");
  CHECK_EQ(copyAsText(), rebuilt);
  CHECK_EQ(feed.reads().size(), std::size_t{14});
  CHECK_EQ(feed.reads().back(), (std::pair<Seq, int>{25, 500}));
  CHECK_EQ(reports.lines, (std::vector<std::string>{"platform subscription.follow.restored cause=epoch"}));
  CHECK_FALSE(lines.sharesARequestWith(reports.requestIds));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{
      "ok/info platform background", "ok/info platform background", "ok/info platform background",
      "ok/info platform background", "ok/info platform background", "ok/info platform background",
      "rebuilt/warn platform background"}));
}

TEST(pg_subscription_follow_caught_up_advances_nothing_and_writes_no_line) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble", "older_period_refunded",
              "account_erased", "caught_up"});
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  FeedFollower follower{feed, copy, {}, reports};
  while (follower.follow() == FollowStep::applied) {}
  const std::string caughtUp = copyAsText();

  FollowLines lines;
  CHECK_EQ(nameOf(follower.follow()), std::string("caughtUp"));
  CHECK_EQ(nameOf(follower.follow()), std::string("caughtUp"));
  CHECK_EQ(copyAsText(), caughtUp);
  CHECK(lines.taken().empty());
  CHECK(reports.lines.empty());
}

TEST(pg_subscription_follow_a_restored_ledger_replaces_the_copy_whole_while_the_old_copy_answers) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble", "older_period_refunded",
              "account_erased", "caught_up"});
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  auto now = std::chrono::steady_clock::time_point{};
  FeedFollower follower{feed, copy, {}, reports, FollowerTiming{}, [&] { return now; }};
  while (follower.follow() == FollowStep::applied) {}
  const std::string beforeRestore = copyAsText();

  // A backup taken at seq 21 is restored: the read after 26 meets a new epoch and a ledger that ends at 21.
  feed.serve({"ledger_restored"});
  feed.serve(0, restored("from_zero", 21));
  feed.serve(6, restored("claimed_then_sandbox", 21));
  feed.serve(13, restored("refunded_then_renewed", 21));
  feed.serve(17, restored("payment_trouble", 21));
  std::vector<std::string> answeredMidway;
  feed.onRead = [&](Seq after) { answeredMidway.push_back(std::to_string(after) + " " + copyAsText()); };
  CHECK_EQ(nameOf(follower.follow()), std::string("rebuilt"));
  feed.onRead = nullptr;

  CHECK_EQ(answeredMidway, (std::vector<std::string>{"26 " + beforeRestore, "0 " + beforeRestore, "6 " + beforeRestore,
                                                     "13 " + beforeRestore, "17 " + beforeRestore}));
  CHECK_EQ(copyAsText(), std::string(
      "cursor 2dd74022-4cb9-42f8-8746-0a186269b54e/21\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=21 production=1805810400000 sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=15 production=- sandbox=-\n"
      "c806aea4-76c0-4868-acbc-3aa7db2b8dd0 seq=13 production=- sandbox=1796742600000\n"));

  // A second restore, to a backup that ends at 6, before the sandbox account was named: it keeps no row.
  now += 6min;
  Json::Value earlier = restored("caught_up", 6);
  feed.serve(21, earlier);
  feed.serve(0, restored("from_zero", 6));
  CHECK_EQ(nameOf(follower.follow()), std::string("rebuilt"));
  CHECK_EQ(copyAsText(), std::string(
      "cursor 2dd74022-4cb9-42f8-8746-0a186269b54e/6\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=3 production=1799056800000 sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=6 production=1799236800000 sandbox=-\n"));
  CHECK_EQ(copy.find(UserId{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"})->body, entitlementExample("active"));
  CHECK_FALSE(copy.find(UserId{"c806aea4-76c0-4868-acbc-3aa7db2b8dd0"}).has_value());
  CHECK_EQ(reports.lines, (std::vector<std::string>{"platform subscription.follow.restored cause=epoch",
                                                    "platform subscription.follow.restored cause=latest_seq_below_cursor"}));
}

TEST(pg_subscription_follow_a_replayed_page_changes_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox"});
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  FeedFollower follower{feed, copy, {}, reports};
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));
  const std::string applied = copyAsText();
  CHECK_EQ(applied, std::string(
      "cursor c09a3ab3-2732-4415-ba88-825ff868cf13/13\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=3 production=1799056800000 sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=7 production=1799236800000 sandbox=-\n"
      "c806aea4-76c0-4868-acbc-3aa7db2b8dd0 seq=13 production=- sandbox=1796742600000\n"));

  // Both pages' entries through the copy again in one transaction, as a page read again is.
  {
    const auto txn = copy.begin(FeedCursor{"c09a3ab3-2732-4415-ba88-825ff868cf13", 13}, false);
    for (const char* name : {"from_zero", "claimed_then_sandbox"}) {
      const FeedPage page{contractExample("feed.json", name)["body"]};
      for (const FeedEntry& entry : page.entries) copy.consume(*txn, entry);
    }
    txn->commit();
  }
  CHECK_EQ(copyAsText(), applied);

  // The service answering again with a page the copy already holds: it does not continue the cursor, and is not applied.
  feed.serve(13, contractExample("feed.json", "claimed_then_sandbox")["body"]);
  CHECK_EQ(nameOf(follower.follow()), std::string("unavailable"));
  CHECK_EQ(copyAsText(), applied);
}

TEST(pg_subscription_follow_a_consumer_that_fails_rolls_the_page_back_and_the_page_is_read_again) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero"});
  PgEntitlementCopy copy{pgTestPool()};

  // A consumer after the copy, as funding will be: it sees the copy's write of the same entry in the page's
  // transaction, and fails once at seq 3.
  struct Funding : FeedEntryConsumer {
    std::vector<std::string> seen;
    bool failed = false;
    void consume(PageTxn& txn, const FeedEntry& entry) override {
      std::string row = "-";
      if (entry.accountId) {
        const pqxx::result rows = sqlOf(txn).exec("SELECT seq FROM account_entitlements WHERE account_id = $1::uuid",
                                                  pqxx::params{entry.accountId->str()});
        row = rows.empty() ? "none" : rows[0][0].as<std::string>();
      }
      seen.push_back(std::to_string(entry.seq) + ":" + row);
      if (entry.seq == 3 && !std::exchange(failed, true)) throw std::runtime_error("PRIVATE_FUNDING_DETAIL");
    }
  } funding;
  Reports reports;
  FollowLines lines;
  FeedFollower follower{feed, copy, FurtherConsumers{.inPage = {funding}}, reports};

  CHECK_EQ(nameOf(follower.follow()), std::string("failed"));
  CHECK_EQ(copyAsText(), std::string("cursor -/0\n"));
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));
  CHECK_EQ(copyAsText(), std::string(
      "cursor c09a3ab3-2732-4415-ba88-825ff868cf13/6\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=3 production=1799056800000 sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=6 production=1799236800000 sandbox=-\n"));
  CHECK_EQ(funding.seen, (std::vector<std::string>{"1:1", "2:2", "3:3", "1:1", "2:2", "3:3", "4:-", "5:-", "6:6"}));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"failed/error platform background", "ok/info platform background"}));
  CHECK_EQ(feed.reads(), (std::vector<std::pair<Seq, int>>{{0, 500}, {0, 500}}));
}

TEST(pg_subscription_follow_a_page_read_while_another_follower_moved_the_cursor_applies_nothing) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox"});
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  FeedFollower follower{feed, copy, {}, reports};
  bool overtook = false;
  feed.onRead = [&](Seq) {
    if (std::exchange(overtook, true)) return;
    FeedFollower other{feed, copy, {}, reports};
    other.follow();
  };

  CHECK_EQ(nameOf(follower.follow()), std::string("overtaken"));
  CHECK_EQ(copyAsText(), std::string(
      "cursor c09a3ab3-2732-4415-ba88-825ff868cf13/6\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=3 production=1799056800000 sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=6 production=1799236800000 sandbox=-\n"));
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));
  CHECK_EQ(feed.reads(), (std::vector<std::pair<Seq, int>>{{0, 500}, {0, 500}, {6, 500}}));
}

TEST(pg_subscription_follow_a_stopped_service_leaves_every_row_answering_and_is_reported_once_it_stalls) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox"});
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  FollowLines lines;
  auto now = std::chrono::steady_clock::time_point{};
  FeedFollower follower{feed, copy, {}, reports, FollowerTiming{}, [&] { return now; }};
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));
  const std::string answering = copyAsText();

  // Nothing answers past 13: the service has stopped.
  now += 1s;
  CHECK_EQ(nameOf(follower.follow()), std::string("unavailable"));
  now += 58s;
  CHECK_EQ(nameOf(follower.follow()), std::string("unavailable"));
  CHECK(reports.lines.empty());
  now += 1s;
  CHECK_EQ(nameOf(follower.follow()), std::string("unavailable"));
  CHECK_EQ(reports.lines, (std::vector<std::string>{"platform subscription.follow.stalled cause=unavailable answer=network"}));
  CHECK_FALSE(lines.sharesARequestWith(reports.requestIds));
  now += 4min;
  CHECK_EQ(nameOf(follower.follow()), std::string("unavailable"));
  CHECK_EQ(reports.lines.size(), std::size_t{1});

  CHECK_EQ(copyAsText(), answering);
  CHECK_EQ(copy.find(UserId{"c806aea4-76c0-4868-acbc-3aa7db2b8dd0"})->body, entitlementExample("sandbox_active"));
  CHECK_EQ(copy.find(UserId{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"})->body, entitlementExample("active"));

  // The service is back, and the follower carries on from where the copy stood.
  feed.serve({"refunded_then_renewed"});
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{
      "ok/info platform background", "ok/info platform background", "unavailable/warn platform background",
      "unavailable/warn platform background", "unavailable/warn platform background",
      "unavailable/warn platform background", "ok/info platform background"}));
}

TEST(pg_subscription_follow_a_cursor_that_stops_while_the_ledger_reports_newer_events_is_reported) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero"});
  // After 6 the service answers no entries while its ledger holds 26.
  feed.serve(6, contractExample("feed.json", "caught_up")["body"]);
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  FollowLines lines;
  auto now = std::chrono::steady_clock::time_point{};
  FeedFollower follower{feed, copy, {}, reports, FollowerTiming{}, [&] { return now; }};
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));

  now += 30s;
  CHECK_EQ(nameOf(follower.follow()), std::string("behind"));
  CHECK(reports.lines.empty());
  now += 30s;
  CHECK_EQ(nameOf(follower.follow()), std::string("behind"));
  CHECK_EQ(reports.lines, (std::vector<std::string>{"platform subscription.follow.stalled cause=behind behind=20"}));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"ok/info platform background", "behind/warn platform background",
                                                    "behind/warn platform background"}));
}

TEST(pg_subscription_follow_reach_returns_once_the_copy_holds_the_seq_and_gives_up_at_its_bound) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero"});
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  // Paced far slower than any wait below, so only being asked makes it read.
  FeedFollower follower{feed, copy, {}, reports, FollowerTiming{.poll = 20s, .retry = 20s, .stallAfter = 60s}};
  follower.start();

  CHECK(follower.reach(6, 5s));

  const auto beforeTimeout = std::chrono::steady_clock::now();
  CHECK_FALSE(follower.reach(7, 300ms));
  const auto waited = std::chrono::steady_clock::now() - beforeTimeout;
  CHECK(waited >= 300ms);
  CHECK(waited < 3s);

  // The claim's events land; asked, the follower reads them at once rather than at its next retry.
  feed.serve({"claimed_then_sandbox"});
  CHECK(follower.reach(7, 5s));
  // The copy holds 13, but no read has begun since this call: the copy alone never answers that a seq is reached.
  CHECK_FALSE(follower.reach(13, 0ms));
  follower.stop();
  CHECK_EQ(copyAsText(), std::string(
      "cursor c09a3ab3-2732-4415-ba88-825ff868cf13/13\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=3 production=1799056800000 sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=7 production=1799236800000 sandbox=-\n"
      "c806aea4-76c0-4868-acbc-3aa7db2b8dd0 seq=13 production=- sandbox=1796742600000\n"));
}

TEST(pg_subscription_follow_side_consumers_write_apart_from_the_page_before_it_commits_and_know_a_rebuild) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox"});
  PgEntitlementCopy copy{pgTestPool()};

  std::vector<std::string> order;
  struct Records : FeedEntryConsumer {
    std::vector<std::string>& order;
    explicit Records(std::vector<std::string>& order) : order(order) {}
    void consume(PageTxn&, const FeedEntry& entry) override { order.push_back("page:" + std::to_string(entry.seq)); }
  } records{order};
  // As funding will: its own short transaction per entry, which sees the copy as last committed, never the page's
  // own writes; it fails once at seq 7.
  struct Funding : FeedEntrySideConsumer {
    std::vector<std::string>& order;
    std::vector<std::string> seen;
    bool failed = false;
    explicit Funding(std::vector<std::string>& order) : order(order) {}
    void consume(const PageTxn& page, const FeedEntry& entry) override {
      order.push_back("side:" + std::to_string(entry.seq));
      std::string row = "-";
      if (entry.accountId) {
        PgLease lease{*pgTestPool()};
        pqxx::read_transaction own{*lease};
        const pqxx::result rows = own.exec("SELECT seq FROM account_entitlements WHERE account_id = $1::uuid",
                                           pqxx::params{entry.accountId->str()});
        row = rows.empty() ? "none" : rows[0][0].as<std::string>();
      }
      seen.push_back(std::to_string(entry.seq) + " " + row + " " + (page.rebuilding() ? "rebuild " : "page ") +
                     page.target().epoch.substr(0, 8) + "/" + std::to_string(page.target().seq));
      if (entry.seq == 7 && !std::exchange(failed, true)) throw std::runtime_error("PRIVATE_FUNDING_DETAIL");
    }
  } funding{order};
  Reports reports;
  FeedFollower follower{feed, copy, FurtherConsumers{.inPage = {records}, .beside = {funding}}, reports};

  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));
  CHECK_EQ(order, (std::vector<std::string>{"page:1", "side:1", "page:2", "side:2", "page:3", "side:3", "page:4", "side:4",
                                            "page:5", "side:5", "page:6", "side:6"}));
  CHECK_EQ(nameOf(follower.follow()), std::string("failed"));
  CHECK_EQ(copyAsText(), std::string(
      "cursor c09a3ab3-2732-4415-ba88-825ff868cf13/6\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=3 production=1799056800000 sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=6 production=1799236800000 sandbox=-\n"));
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));

  // Restored whole at 13 under a new epoch: the rebuild tells every consumer so, and the old copy still answers them.
  feed.serve(13, restored("caught_up", 13));
  feed.serve(0, restored("from_zero", 13));
  feed.serve(6, restored("claimed_then_sandbox", 13));
  CHECK_EQ(nameOf(follower.follow()), std::string("rebuilt"));
  CHECK_EQ(funding.seen, (std::vector<std::string>{
      "1 none page c09a3ab3/6", "2 none page c09a3ab3/6", "3 none page c09a3ab3/6", "4 - page c09a3ab3/6",
      "5 - page c09a3ab3/6", "6 none page c09a3ab3/6",
      "7 6 page c09a3ab3/13",
      "7 6 page c09a3ab3/13", "9 none page c09a3ab3/13", "10 none page c09a3ab3/13", "11 none page c09a3ab3/13",
      "12 none page c09a3ab3/13", "13 none page c09a3ab3/13",
      "1 3 rebuild 2dd74022/13", "2 3 rebuild 2dd74022/13", "3 3 rebuild 2dd74022/13", "4 - rebuild 2dd74022/13",
      "5 - rebuild 2dd74022/13", "6 7 rebuild 2dd74022/13", "7 7 rebuild 2dd74022/13", "9 13 rebuild 2dd74022/13",
      "10 13 rebuild 2dd74022/13", "11 13 rebuild 2dd74022/13", "12 13 rebuild 2dd74022/13",
      "13 13 rebuild 2dd74022/13"}));
  CHECK_EQ(copyAsText(), std::string(
      "cursor 2dd74022-4cb9-42f8-8746-0a186269b54e/13\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=3 production=1799056800000 sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=7 production=1799236800000 sandbox=-\n"
      "c806aea4-76c0-4868-acbc-3aa7db2b8dd0 seq=13 production=- sandbox=1796742600000\n"));
}

TEST(pg_subscription_follow_reach_counts_only_a_read_that_began_after_it_and_saw_the_ledgers_epoch) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble", "older_period_refunded",
              "account_erased", "caught_up"});
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  FeedFollower follower{feed, copy, {}, reports, FollowerTiming{.poll = 20s, .retry = 20s, .stallAfter = 60s}};
  follower.start();
  CHECK(follower.reach(26, 5s));

  // The service is restored from a backup at 21 and cannot be read yet: the copy's 26 belongs to the old ledger, and a
  // claim's 22 is not reached by it.
  feed.stopServing(26);
  CHECK_FALSE(follower.reach(22, 300ms));

  // The service answers again, restored at 21 under a new epoch, holding a claim recorded at 22.
  Json::Value claim = restored("caught_up", 22);
  Json::Value entry = contractExample("feed.json", "from_zero")["body"]["entries"][2];
  entry["seq"] = Json::UInt64(22);
  claim["entries"].append(entry);
  feed.serve(0, restored("from_zero", 22));
  feed.serve(6, restored("claimed_then_sandbox", 22));
  feed.serve(13, restored("refunded_then_renewed", 22));
  feed.serve(17, restored("payment_trouble", 22));
  feed.serve(21, claim);
  feed.serve(26, restored("caught_up", 22));
  CHECK(follower.reach(22, 5s));
  CHECK_EQ(copyAsText(), std::string(
      "cursor 2dd74022-4cb9-42f8-8746-0a186269b54e/22\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=22 production=1799056800000 sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=15 production=- sandbox=-\n"
      "c806aea4-76c0-4868-acbc-3aa7db2b8dd0 seq=13 production=- sandbox=1796742600000\n"));
  follower.stop();
}

TEST(pg_subscription_follow_a_rebuild_never_takes_a_prefix_of_the_ledger_for_the_whole) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble", "older_period_refunded",
              "account_erased", "caught_up"});
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  FeedFollower follower{feed, copy, {}, reports};
  while (follower.follow() == FollowStep::applied) {}
  const std::string followed = copyAsText();

  // Restored whole under a new epoch, but the page after 6 comes back empty while the ledger holds 26.
  feed.serve(26, restored("caught_up", 26));
  feed.serve(0, restored("from_zero", 26));
  feed.serve(6, restored("caught_up", 26));
  FollowLines lines;
  CHECK_EQ(nameOf(follower.follow()), std::string("unavailable"));
  CHECK_EQ(copyAsText(), followed);
  CHECK_EQ(copy.find(UserId{"9387ec65-ab17-4b8c-b145-fd0d622966db"})->body, entitlementExample("revoked"));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"unavailable/warn platform background"}));
}

TEST(pg_subscription_follow_any_body_the_feed_reads_is_storable) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  // A NUL is a JSON string's right, which jsonb refuses; the copy keeps the body whole.
  Json::Value page = contractExample("feed.json", "from_zero")["body"];
  page["entries"][2]["entitlement"]["production"]["governing"]["nextProductId"] = std::string("one\0x", 5);
  FakeFeed feed;
  feed.serve(0, page);
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  FeedFollower follower{feed, copy, {}, reports};
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));
  CHECK_EQ(copy.find(UserId{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"})->body, page["entries"][2]["entitlement"]);
  CHECK_EQ(copy.find(UserId{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"})
               ->body["production"]["governing"]["nextProductId"].asString(),
           std::string("one\0x", 5));
}

TEST(pg_subscription_follow_a_malformed_entry_holds_the_copy_where_it_stands_and_is_reported) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  Json::Value page = contractExample("feed.json", "from_zero")["body"];
  page["entries"][5]["entitlement"]["sandbox"]["accessUntil"] = "soon";
  FakeFeed feed;
  feed.serve(0, page);
  PgEntitlementCopy copy{pgTestPool()};
  Reports reports;
  auto now = std::chrono::steady_clock::time_point{};
  FeedFollower follower{feed, copy, {}, reports, FollowerTiming{}, [&] { return now; }};
  std::string steps;
  for (int read = 0; read < 3; ++read) {
    steps += nameOf(follower.follow()) + " ";
    now += 30s;
  }
  CHECK_EQ(steps, std::string("unavailable unavailable unavailable "));
  CHECK_EQ(copyAsText(), std::string("cursor -/0\n"));
  CHECK_EQ(reports.lines, (std::vector<std::string>{"platform subscription.follow.stalled cause=unavailable answer=malformed"}));
}

TEST(pg_subscription_follow_a_word_the_contract_does_not_name_yet_reaches_the_copy_and_is_reported_once) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshCopy();
  Json::Value first = contractExample("feed.json", "from_zero")["body"];
  first["entries"][1]["store"] = "Galaxy Store";
  first["entries"][3]["offerKind"] = "half_price";
  first["entries"][5]["type"] = "gifted";
  Json::Value second = contractExample("feed.json", "claimed_then_sandbox")["body"];
  second["entries"][0]["type"] = "gifted";
  FakeFeed feed;
  feed.serve(0, first);
  feed.serve(6, second);
  PgEntitlementCopy copy{pgTestPool()};

  struct Seen : FeedEntryConsumer {
    std::vector<std::string> seen;
    void consume(PageTxn&, const FeedEntry& entry) override {
      seen.push_back(std::to_string(entry.seq) + (entry.knownType ? "" : " unknown"));
    }
  } further;
  Reports reports;
  FollowLines lines;
  FeedFollower follower{feed, copy, FurtherConsumers{.inPage = {further}}, reports};
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));
  // The unknown event at 6 is the last to name 9387ec65: the copy took its entitlement all the same.
  CHECK_EQ(copyAsText(), std::string(
      "cursor c09a3ab3-2732-4415-ba88-825ff868cf13/6\n"
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 seq=3 production=1799056800000 sandbox=-\n"
      "9387ec65-ab17-4b8c-b145-fd0d622966db seq=6 production=1799236800000 sandbox=-\n"));
  CHECK_EQ(nameOf(follower.follow()), std::string("applied"));

  CHECK_EQ(further.seen, (std::vector<std::string>{"1", "2", "3", "4", "5", "6 unknown", "7 unknown", "9", "10", "11",
                                                   "12", "13"}));
  CHECK_EQ(reports.lines, (std::vector<std::string>{"platform subscription.follow.unknown_word store=(not a word)",
                                                    "platform subscription.follow.unknown_word offerKind=half_price",
                                                    "platform subscription.follow.unknown_word type=gifted"}));
  CHECK_FALSE(lines.sharesARequestWith(reports.requestIds));
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"ok/info platform background", "ok/info platform background"}));
}
