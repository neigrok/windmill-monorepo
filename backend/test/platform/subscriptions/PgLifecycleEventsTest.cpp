#include "platform/subscriptions/PgLifecycleEvents.h"

#include "platform/adapters/amplitude/AmplitudeClient.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/subscriptions/FeedFollower.h"
#include "platform/subscriptions/PgEntitlementCopy.h"
#include "test/PgTestPool.h"
#include "test/platform/subscriptions/FeedFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <chrono>
#include <cstdlib>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// Opt-in integration cases: a live Postgres built by db/schema.sql and WM_PG_TEST set (RUNNING.md §7); otherwise each
// reports skip. The fake feed serves the golden pages of packages/api-contract/subscriptions/feed.json.
using namespace wm;
using namespace wm::subscriptions;
using namespace wm::subscriptions::test;

namespace {
// An empty copy that never read the feed and no event the server recorded, beside the accounts this backend holds.
void freshLedger(const std::vector<std::string>& heldAccounts) {
  PgLease lease{*pgTestPool()};
  pqxx::work txn{*lease};
  txn.exec("DELETE FROM account_entitlements");
  txn.exec("UPDATE subscription_feed_cursor SET epoch = NULL, seq = 0");
  txn.exec("DELETE FROM server_event_keys");
  txn.exec("DELETE FROM events WHERE name LIKE 'subscription\\_%'");
  txn.exec("DELETE FROM users WHERE id IN ('3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61', '9387ec65-ab17-4b8c-b145-fd0d622966db', "
           "'c806aea4-76c0-4868-acbc-3aa7db2b8dd0')");
  for (const std::string& account : heldAccounts)
    txn.exec("INSERT INTO users (id, email) VALUES ($1::uuid, $2)",
             pqxx::params{account, "lifecycle-" + account + "@example.com"});
  txn.commit();
}

// Every event the server recorded, as the events table holds it: name, time, device key, account and properties.
std::string recordedEvents() {
  PgLease lease{*pgTestPool()};
  pqxx::read_transaction txn{*lease};
  const pqxx::result rows = txn.exec(
      "SELECT name, client_ms, coalesce(session_key, '-'), coalesce(user_id::text, '-'), props::text FROM events "
      "WHERE name LIKE 'subscription\\_%' ORDER BY id");
  std::string text;
  for (const auto row : rows)
    text += row[0].as<std::string>() + " " + row[1].as<std::string>() + " " + row[2].as<std::string>() + " " +
            row[3].as<std::string>() + " " + row[4].as<std::string>() + "\n";
  return text;
}

// The forwarder, holding what Amplitude would be sent: each forward's batch, as the client builds it.
struct AmplitudeBatches : EventForwarder {
  std::vector<std::string> sent;
  void forward(const std::string& sessionKey, const std::optional<UserId>& user, const std::vector<FunnelEvent>& events,
               const std::string& idSeed) override {
    sent.push_back(dump(amplitudeEvents(sessionKey, user, events, idSeed)));
  }
};

// Every `subscription.record` completion line, as outcome/level, for as long as it lives.
class RecordLines {
public:
  RecordLines() {
    installWriteSink([this](const WriteCompletion& line) {
      if (line.operation != "subscription.record") return;
      const char* level = line.severity == WriteSeverity::error  ? "error"
                          : line.severity == WriteSeverity::warn ? "warn"
                          : line.severity == WriteSeverity::info ? "info"
                                                                 : "debug";
      std::lock_guard lock{mutex_};
      lines_.push_back(line.outcome + "/" + level);
    });
  }
  ~RecordLines() { installWriteSink({}); }

  std::vector<std::string> taken() {
    std::lock_guard lock{mutex_};
    return lines_;
  }

private:
  std::mutex mutex_;
  std::vector<std::string> lines_;
};

struct Reports : FailureReporter {
  std::vector<std::string> lines;
  void report(const std::string& kind, const std::string& where, const std::string& detail) override {
    lines.push_back(kind + " " + where + " " + detail);
  }
};
}

TEST(pg_subscription_lifecycle_the_fixture_ledger_records_each_lifecycle_event_once_and_forwards_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger({"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61", "9387ec65-ab17-4b8c-b145-fd0d622966db",
               "c806aea4-76c0-4868-acbc-3aa7db2b8dd0"});
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble", "older_period_refunded",
              "account_erased", "caught_up"});
  PgEntitlementCopy copy{pgTestPool()};
  PgEventRepository events{pgTestPool()};
  AmplitudeBatches amplitude;
  PgLifecycleEvents lifecycle{events, amplitude};
  Reports reports;
  RecordLines lines;
  FeedFollower follower{feed, copy, FurtherConsumers{.inPage = {lifecycle}}, reports};

  while (follower.follow() == FollowStep::applied) {}

  // Nine of the ledger's 26 events are lifecycle events; the bound, period, updated, recovered and unbound ones are not.
  CHECK_EQ(recordedEvents(), std::string(
      "subscription_started 1796292000000 - "
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"
      "subscription_started 1796472000000 subscription-39091790c683cbb7c60819fca412780e "
      "- {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"
      "subscription_started 1796742000000 - "
      "c806aea4-76c0-4868-acbc-3aa7db2b8dd0 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"sandbox\"}\n"
      "subscription_renewed 1796742300000 - "
      "c806aea4-76c0-4868-acbc-3aa7db2b8dd0 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"sandbox\"}\n"
      "subscription_revoked 1797780600000 - "
      "9387ec65-ab17-4b8c-b145-fd0d622966db {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"
      "subscription_renewed 1798966800000 - "
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"
      "subscription_payment_failed 1801648800000 - "
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"
      "subscription_renewal_turned_off 1804708800000 - "
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"
      "subscription_expired 1805724000000 - "
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"));
  // What Amplitude is sent: the account the entry names, or the subscription's device for the start no account held yet,
  // never both; the event's own time; and an insert_id that is the same however often the event is told.
  CHECK_EQ(amplitude.sent, (std::vector<std::string>{
      R"([{"event_properties":{"environment":"production","offer_kind":"none","store":"app_store"},"event_type":"subscription_started","insert_id":"6927e7ab1d4daf287bbe9eaf1cb62da8","time":1796292000000,"user_id":"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"}])",
      R"([{"device_id":"subscription-39091790c683cbb7c60819fca412780e","event_properties":{"environment":"production","offer_kind":"none","store":"app_store"},"event_type":"subscription_started","insert_id":"subscription-39091790c683cbb7c60819fca412780e:c232e42479e0a1a2a39f47246943c83b","time":1796472000000}])",
      R"([{"event_properties":{"environment":"sandbox","offer_kind":"none","store":"app_store"},"event_type":"subscription_started","insert_id":"6d76e73f40024fe6eadff23b76e16bae","time":1796742000000,"user_id":"c806aea4-76c0-4868-acbc-3aa7db2b8dd0"}])",
      R"([{"event_properties":{"environment":"sandbox","offer_kind":"none","store":"app_store"},"event_type":"subscription_renewed","insert_id":"e5b39f4ee3f9f9e9971b73a582b8df4c","time":1796742300000,"user_id":"c806aea4-76c0-4868-acbc-3aa7db2b8dd0"}])",
      R"([{"event_properties":{"environment":"production","offer_kind":"none","store":"app_store"},"event_type":"subscription_revoked","insert_id":"c5b3aeac3e3136bd5d0f0a09a5f7b568","time":1797780600000,"user_id":"9387ec65-ab17-4b8c-b145-fd0d622966db"}])",
      R"([{"event_properties":{"environment":"production","offer_kind":"none","store":"app_store"},"event_type":"subscription_renewed","insert_id":"43ce59fb286068f6dab570bf4feecc28","time":1798966800000,"user_id":"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"}])",
      R"([{"event_properties":{"environment":"production","offer_kind":"none","store":"app_store"},"event_type":"subscription_payment_failed","insert_id":"90bc45a9d76a91ec898b2e9b7ac7ed36","time":1801648800000,"user_id":"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"}])",
      R"([{"event_properties":{"environment":"production","offer_kind":"none","store":"app_store"},"event_type":"subscription_renewal_turned_off","insert_id":"6b093a3650ef70accda7819875633eb9","time":1804708800000,"user_id":"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"}])",
      R"([{"event_properties":{"environment":"production","offer_kind":"none","store":"app_store"},"event_type":"subscription_expired","insert_id":"b8f85d1339d30e9f91880df02046bb3e","time":1805724000000,"user_id":"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"}])"}));
  CHECK_EQ(lines.taken(), std::vector<std::string>(9, "ok/debug"));
  CHECK(reports.lines.empty());

  // Each row carries the key it was recorded once under, and every name it records is one the intake refuses a client.
  {
    PgLease lease{*pgTestPool()};
    pqxx::read_transaction txn{*lease};
    std::string keys;
    for (const auto row : txn.exec("SELECT e.name, e.server_key FROM events e JOIN server_event_keys k ON k.key = "
                                   "e.server_key WHERE e.name LIKE 'subscription\\_%' ORDER BY e.id")) {
      keys += row[1].as<std::string>() + " ";
      CHECK(kServerOriginEvents.count(row[0].as<std::string>()));
    }
    CHECK_EQ(keys, std::string(
        "6927e7ab1d4daf287bbe9eaf1cb62da8 c232e42479e0a1a2a39f47246943c83b 6d76e73f40024fe6eadff23b76e16bae "
        "e5b39f4ee3f9f9e9971b73a582b8df4c c5b3aeac3e3136bd5d0f0a09a5f7b568 43ce59fb286068f6dab570bf4feecc28 "
        "90bc45a9d76a91ec898b2e9b7ac7ed36 6b093a3650ef70accda7819875633eb9 b8f85d1339d30e9f91880df02046bb3e "));
  }
}

TEST(pg_subscription_lifecycle_a_page_read_again_records_and_forwards_nothing_twice) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger({"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61", "9387ec65-ab17-4b8c-b145-fd0d622966db"});
  FakeFeed feed;
  feed.serve({"from_zero"});
  PgEntitlementCopy copy{pgTestPool()};
  PgEventRepository events{pgTestPool()};
  AmplitudeBatches amplitude;
  PgLifecycleEvents lifecycle{events, amplitude};

  // A consumer after this one fails once at seq 5: the page rolls back with the two starts it had recorded, and tells
  // Amplitude of neither.
  struct FailsOnce : FeedEntryConsumer {
    bool failed = false;
    void consume(PageTxn&, const FeedEntry& entry) override {
      if (entry.seq == 5 && !std::exchange(failed, true)) throw std::runtime_error("PRIVATE_CONSUMER_DETAIL");
    }
  } later;
  Reports reports;
  RecordLines lines;
  FeedFollower follower{feed, copy, FurtherConsumers{.inPage = {lifecycle, later}}, reports};

  CHECK_EQ(follower.follow(), FollowStep::failed);
  CHECK_EQ(recordedEvents(), std::string());
  CHECK(amplitude.sent.empty());

  // Read again, the page records each once and tells Amplitude once it commits.
  CHECK_EQ(follower.follow(), FollowStep::applied);
  const std::string applied = recordedEvents();
  CHECK_EQ(applied, std::string(
      "subscription_started 1796292000000 - "
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"
      "subscription_started 1796472000000 subscription-39091790c683cbb7c60819fca412780e "
      "- {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"));
  CHECK_EQ(amplitude.sent.size(), std::size_t{2});

  // The committed page's entries through the copy and the recorder again, as a page the service serves twice would be.
  {
    const auto txn = copy.begin(FeedCursor{"c09a3ab3-2732-4415-ba88-825ff868cf13", 6}, false);
    for (const FeedEntry& entry : FeedPage{contractExample("feed.json", "from_zero")["body"]}.entries) {
      copy.consume(*txn, entry);
      lifecycle.consume(*txn, entry);
    }
    txn->commit();
  }
  CHECK_EQ(recordedEvents(), applied);
  CHECK_EQ(amplitude.sent.size(), std::size_t{2});
  CHECK_EQ(lines.taken(), (std::vector<std::string>{"ok/debug", "ok/debug", "ok/debug", "ok/debug", "unchanged/info",
                                                    "unchanged/info"}));
}

TEST(pg_subscription_lifecycle_a_restored_ledger_rebuilds_the_copy_and_records_nothing_twice) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger({"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61", "9387ec65-ab17-4b8c-b145-fd0d622966db",
               "c806aea4-76c0-4868-acbc-3aa7db2b8dd0"});
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble", "older_period_refunded",
              "account_erased", "caught_up"});
  PgEntitlementCopy copy{pgTestPool()};
  PgEventRepository events{pgTestPool()};
  AmplitudeBatches amplitude;
  PgLifecycleEvents lifecycle{events, amplitude};
  Reports reports;
  FeedFollower follower{feed, copy, FurtherConsumers{.inPage = {lifecycle}}, reports};
  while (follower.follow() == FollowStep::applied) {}
  const std::string followed = recordedEvents();
  REQUIRE_EQ(amplitude.sent.size(), std::size_t{9});

  // A backup taken at seq 21 is restored: the follower reads its ledger whole under the new epoch and rebuilds the copy.
  feed.serve({"ledger_restored"});
  feed.serve(0, restored("from_zero", 21));
  feed.serve(6, restored("claimed_then_sandbox", 21));
  feed.serve(13, restored("refunded_then_renewed", 21));
  feed.serve(17, restored("payment_trouble", 21));
  CHECK_EQ(follower.follow(), FollowStep::rebuilt);
  CHECK_EQ(recordedEvents(), followed);
  CHECK_EQ(amplitude.sent.size(), std::size_t{9});

  // The service hears the store again and the restored ledger grows past 21 with the same two events under other seqs:
  // each is the event already recorded.
  Json::Value regrown = restored("older_period_refunded", 23);
  Json::Value entries(Json::arrayValue);
  for (const Json::Value& entry : regrown["entries"])
    if (entry["type"] == "renewal_turned_off" || entry["type"] == "expired") entries.append(entry);
  entries[0]["seq"] = 22;
  entries[1]["seq"] = 23;
  regrown["entries"] = entries;
  feed.serve(21, regrown);
  CHECK_EQ(follower.follow(), FollowStep::applied);
  CHECK_EQ(copy.cursor(), (FeedCursor{"2dd74022-4cb9-42f8-8746-0a186269b54e", 23}));
  CHECK_EQ(recordedEvents(), followed);
  CHECK_EQ(amplitude.sent.size(), std::size_t{9});
}

TEST(pg_subscription_lifecycle_an_event_retention_or_erasure_took_is_not_recorded_again_by_a_rebuild) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger({"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61", "9387ec65-ab17-4b8c-b145-fd0d622966db",
               "c806aea4-76c0-4868-acbc-3aa7db2b8dd0"});
  FakeFeed feed;
  feed.serve({"from_zero", "claimed_then_sandbox", "refunded_then_renewed"});
  PgEntitlementCopy copy{pgTestPool()};
  PgEventRepository events{pgTestPool()};
  AmplitudeBatches amplitude;
  PgLifecycleEvents lifecycle{events, amplitude};
  Reports reports;
  FeedFollower follower{feed, copy, FurtherConsumers{.inPage = {lifecycle}}, reports};
  for (int read = 0; read < 3; ++read) CHECK_EQ(follower.follow(), FollowStep::applied);
  REQUIRE_EQ(amplitude.sent.size(), std::size_t{6});

  // Retention ages out the first start, and 9387ec65 is erased with its events, as the account's erasure does.
  {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec("DELETE FROM events WHERE name = 'subscription_started' AND client_ms = 1796292000000");
    txn.exec("DELETE FROM events WHERE user_id = '9387ec65-ab17-4b8c-b145-fd0d622966db'");
    txn.exec("DELETE FROM users WHERE id = '9387ec65-ab17-4b8c-b145-fd0d622966db'");
    txn.commit();
  }
  const std::string kept = recordedEvents();
  CHECK_EQ(kept, std::string(
      "subscription_started 1796472000000 subscription-39091790c683cbb7c60819fca412780e "
      "- {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"
      "subscription_started 1796742000000 - "
      "c806aea4-76c0-4868-acbc-3aa7db2b8dd0 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"sandbox\"}\n"
      "subscription_renewed 1796742300000 - "
      "c806aea4-76c0-4868-acbc-3aa7db2b8dd0 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"sandbox\"}\n"
      "subscription_renewed 1798966800000 - "
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"));

  // The ledger is restored whole, to 26, under a new epoch: the rebuild records the three events the copy had not read,
  // and none of those already recorded, whether their rows are still here or not.
  for (const char* name : {"from_zero", "claimed_then_sandbox", "refunded_then_renewed", "payment_trouble",
                           "older_period_refunded", "account_erased", "caught_up"})
    feed.serve(contractExample("feed.json", name)["request"]["after"].asUInt64(), restored(name, 26));
  CHECK_EQ(follower.follow(), FollowStep::rebuilt);
  CHECK_EQ(recordedEvents(), kept + std::string(
      "subscription_payment_failed 1801648800000 - "
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"
      "subscription_renewal_turned_off 1804708800000 - "
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"
      "subscription_expired 1805724000000 - "
      "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61 {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"));
  CHECK_EQ(amplitude.sent.size(), std::size_t{9});
}

TEST(pg_subscription_lifecycle_records_only_the_allowlist_and_unknown_words_as_unknown) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  // 3f6c2a1e is not an account this backend holds: its events are recorded as no one's.
  freshLedger({"9387ec65-ab17-4b8c-b145-fd0d622966db"});
  Json::Value page = contractExample("feed.json", "from_zero")["body"];
  page["entries"][0]["offerKind"] = "half_price";
  page["entries"][3]["store"] = "Galaxy Store";
  page["entries"][3]["offerKind"] = "free_trial";
  page["entries"][5]["type"] = "gifted";
  page["entries"][5]["offerKind"] = "win_back";
  FakeFeed feed;
  feed.serve(0, page);
  PgEntitlementCopy copy{pgTestPool()};
  PgEventRepository events{pgTestPool()};
  AmplitudeBatches amplitude;
  PgLifecycleEvents lifecycle{events, amplitude};
  Reports reports;
  FeedFollower follower{feed, copy, FurtherConsumers{.inPage = {lifecycle}}, reports};

  CHECK_EQ(follower.follow(), FollowStep::applied);
  CHECK_EQ(recordedEvents(), std::string(
      "subscription_started 1796292000000 subscription-3060389043f8b1972136c93d7e63ae88 "
      "- {\"store\": \"app_store\", \"offer_kind\": \"unknown\", \"environment\": \"production\"}\n"
      "subscription_started 1796472000000 subscription-39091790c683cbb7c60819fca412780e "
      "- {\"store\": \"unknown\", \"offer_kind\": \"free_trial\", \"environment\": \"production\"}\n"));
  CHECK_EQ(amplitude.sent, (std::vector<std::string>{
      R"([{"device_id":"subscription-3060389043f8b1972136c93d7e63ae88","event_properties":{"environment":"production","offer_kind":"unknown","store":"app_store"},"event_type":"subscription_started","insert_id":"subscription-3060389043f8b1972136c93d7e63ae88:6927e7ab1d4daf287bbe9eaf1cb62da8","time":1796292000000}])",
      R"([{"device_id":"subscription-39091790c683cbb7c60819fca412780e","event_properties":{"environment":"production","offer_kind":"free_trial","store":"unknown"},"event_type":"subscription_started","insert_id":"subscription-39091790c683cbb7c60819fca412780e:c232e42479e0a1a2a39f47246943c83b","time":1796472000000}])"}));
}

TEST(pg_subscription_lifecycle_a_page_and_the_final_erasure_of_its_account_both_complete) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  freshLedger({"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"});
  FakeFeed feed;
  feed.serve({"from_zero"});
  PgEntitlementCopy copy{pgTestPool()};
  PgEventRepository events{pgTestPool()};
  AmplitudeBatches amplitude;
  PgLifecycleEvents lifecycle{events, amplitude};
  Reports reports;
  FeedFollower follower{feed, copy, FurtherConsumers{.inPage = {lifecycle}}, reports};
  REQUIRE_EQ(follower.follow(), FollowStep::applied);
  {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec("UPDATE users SET deleted_at = now() - interval '40 days', closes_at = now() - interval '1 day' "
             "WHERE id = '3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61'");
    txn.commit();
  }

  // 3f6c2a1e's renewal reaches the page while its account's erasure begins: the copy has written the account's row,
  // the erasure asks for the account, and the renewal is recorded after. Both complete, the erasure last.
  Json::Value renewal = contractExample("feed.json", "from_zero")["body"]["entries"][0];
  renewal["seq"] = 7;
  renewal["type"] = "renewed";
  renewal["occurredAt"] = Json::Int64{1798966800000};
  const FeedEntry renewed{renewal};
  PgAuthRepository accounts{pgTestPool()};
  std::string erased = "not run";
  {
    const auto txn = copy.begin(FeedCursor{"c09a3ab3-2732-4415-ba88-825ff868cf13", 7}, false);
    copy.consume(*txn, renewed);
    std::thread eraser([&] {
      const auto now = std::chrono::system_clock::now().time_since_epoch();
      try {
        erased = accounts.eraseAccount(UserId{"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61"},
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
    lifecycle.consume(*txn, renewed);
    txn->commit();
    eraser.join();
  }

  CHECK_EQ(erased, std::string("erased"));
  // The erasure took every event the account was named in, the renewal recorded before it included.
  CHECK_EQ(recordedEvents(), std::string(
      "subscription_started 1796472000000 subscription-39091790c683cbb7c60819fca412780e "
      "- {\"store\": \"app_store\", \"offer_kind\": \"none\", \"environment\": \"production\"}\n"));
  CHECK_EQ(amplitude.sent.size(), std::size_t{3});
}
