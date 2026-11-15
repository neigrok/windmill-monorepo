#include "platform/subscriptions/SubscriptionApi.h"

#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/WriteRoutes.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/subscriptions/PgEntitlementCopy.h"
#include "test/PgTestPool.h"
#include "test/platform/Fakes.h"
#include "test/platform/subscriptions/FeedFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// GET /v1/subscription and POST /v1/subscription/app-store/claims over the Postgres copy (RUNNING.md §7): every case
// needs WM_PG_TEST and skips without it.
using namespace wm;
using namespace wm::subscriptions;
using namespace wm::subscriptions::test;
using namespace std::chrono_literals;

namespace {

struct Reports : FailureReporter {
  std::vector<std::string> seen;
  void report(const std::string& kind, const std::string& operation, const std::string&) override {
    seen.push_back(kind + " " + operation);
  }
};

// The service's claim door, answering each claim with `answer`; every claim it is asked is kept.
struct FakeClaims : AppStoreClaims {
  std::function<ClaimAnswer()> answer;

  // Answers what internal-app-store-claim.json pins under `name`.
  void answers(const std::string& name) {
    const Json::Value example = contractExample("internal-app-store-claim.json", name);
    answer = [example] { return ClaimAnswer{example["status"].asInt(), example["body"]}; };
  }

  std::vector<std::pair<std::string, std::string>> asked() {
    std::lock_guard lock{mutex_};
    return asked_;
  }

  ClaimAnswer claim(const UserId& account, const std::string& signedTransaction) override {
    {
      std::lock_guard lock{mutex_};
      asked_.emplace_back(account.str(), signedTransaction);
    }
    return answer();
  }

private:
  std::mutex mutex_;
  std::vector<std::pair<std::string, std::string>> asked_;
};

// What a claim came to: the device's answer and the claim's one line, as `outcome/level product door`.
struct Claimed {
  drogon::HttpResponsePtr reply;
  std::string line;
};

// The server's subscription doors as main.cpp composes them, over the copy's rows and `clock`, the one access is read
// against, which the case sets. Sessions keep a clock of their own, so a case that moves `clock` years ahead signs no
// one out. Each account signs in with the session secret "s-" + its id. A claim goes to `service` and waits on
// `follower`, which follows `feed` once a case starts it.
struct Door {
  fake::FakeAuthRepository accounts;
  fake::FakeEmail email;
  fake::FakeTokens tokens;
  fake::FakeClock sessionClock;
  fake::FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, sessionClock};
  fake::FakeAccountFootprint footprint;
  fake::FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(accounts, email, tokens, sessionClock, oauth,
                                                                    footprint, revocations, "https://windmill.works");
  fake::FakeClock clock;
  PgEntitlementCopy copy{pgTestPool()};
  fake::FakeAiUsageRepository usage;
  std::shared_ptr<Reports> reports = std::make_shared<Reports>();
  FakeFeed feed;
  std::shared_ptr<FakeClaims> service = std::make_shared<FakeClaims>();
  std::shared_ptr<FeedFollower> follower = std::make_shared<FeedFollower>(feed, copy, FurtherConsumers{}, *reports);
  std::shared_ptr<WorkerPool> workers = std::make_shared<WorkerPool>("subscription-claim", 1, 4);

  Door() {
    sql("DELETE FROM account_entitlements");
    sql("UPDATE subscription_feed_cursor SET epoch = NULL, seq = 0");
    for (const char* id : {"3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61", "9387ec65-ab17-4b8c-b145-fd0d622966db",
                           "c806aea4-76c0-4868-acbc-3aa7db2b8dd0", "60eb0e14-f50c-49d6-a496-56ef6c8d4e8e"}) {
      const std::string address = std::string("subscriber-") + id + "@example.com";
      sql("INSERT INTO users (id, email) VALUES ('" + std::string(id) + "', '" + address + "') ON CONFLICT (id) DO NOTHING");
      const User user{UserId{id}, Email{address}, "Subscriber", {}};
      accounts.usersById[id] = user;
      accounts.usersByEmail[address] = user;
      accounts.insertSession(tokens.digestOf(std::string("s-") + id), user.id, sessionClock.now + 1'000'000, "", "",
                             sessionClock.now);
    }
    installWriteReporter(reports);
    installWriteSink([this](const WriteCompletion& line) {
      if (line.operation != "subscription.claim") return;
      const char* level = line.severity == WriteSeverity::error  ? "error"
                          : line.severity == WriteSeverity::warn ? "warn"
                          : line.severity == WriteSeverity::info ? "info"
                                                                 : "debug";
      std::lock_guard lock{linesMutex_};
      lines_.push_back(line.outcome + "/" + level + " " + line.product + " " + line.door);
      written_.notify_all();
    });
  }

  ~Door() {
    installWriteSink({});
    installWriteReporter({});
    sql("DELETE FROM account_entitlements");
    sql("UPDATE subscription_feed_cursor SET epoch = NULL, seq = 0");
  }

  static void sql(const std::string& statement) {
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec(statement);
    txn.commit();
  }

  // The row the follower leaves for an entitlement the feed carried.
  void seed(const Json::Value& entitlement) {
    const EntitlementResponse row{entitlement};
    PgLease lease{*pgTestPool()};
    pqxx::work txn{*lease};
    txn.exec("INSERT INTO account_entitlements (account_id, production_access_until, sandbox_access_until, entitlement, seq) "
             "VALUES ($1::uuid, $2, $3, $4::json, 1)",
             pqxx::params{row.accountId.str(), row.productionAccessUntil, row.sandboxAccessUntil, dump(entitlement)});
    txn.commit();
  }

  // The feed's ledger as the claim left it: the recorded events up to the claim's last, seq 7, the newest it holds.
  void serveTheLedgerToTheClaim() {
    Json::Value upToTheClaim = contractExample("feed.json", "from_zero")["body"];
    upToTheClaim["latestSeq"] = Json::UInt64{7};
    Json::Value theClaim = contractExample("feed.json", "claimed_then_sandbox")["body"];
    Json::Value claimEntries(Json::arrayValue);
    claimEntries.append(theClaim["entries"][0]);
    theClaim["entries"] = claimEntries;
    theClaim["latestSeq"] = Json::UInt64{7};
    Json::Value caughtUp = contractExample("feed.json", "caught_up")["body"];
    caughtUp["latestSeq"] = Json::UInt64{7};
    feed.serve(0, upToTheClaim);
    feed.serve(6, theClaim);
    feed.serve(7, caughtUp);
  }

  drogon::HttpResponsePtr read(const std::string& account, Allowlists lists, const std::string& purchasableStores) {
    auto entitlements = std::make_shared<Entitlements>(copy, clock, usage, std::move(lists));
    SubscriptionApi api{auth, entitlements, PaidLine{purchasableStores, 7'000'000'000}, reports};
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Get);
    request->setPath("/v1/subscription");
    if (!account.empty()) request->addCookie("wm_session", "s-" + account);
    drogon::HttpResponsePtr answer;
    api.get(request, [&](const drogon::HttpResponsePtr& response) { answer = response; });
    return answer;
  }

  // A claim of `body` through the write route main.cpp registers, on the line open on the App Store. The door forwards
  // it to `service` and waits on `follower` at most `wait`, unless `following` is false, as while the follower is off.
  // Answers once the claim's line is written, which may be on the claim's own thread.
  Claimed claim(const std::string& account, const Json::Value& body, bool following = true,
                std::chrono::milliseconds wait = 5s) {
    auto entitlements = std::make_shared<Entitlements>(copy, clock, usage, Allowlists{});
    std::optional<ClaimForwarding> forwarding;
    if (following) forwarding = ClaimForwarding{service, follower, workers, wait};
    SubscriptionApi api{auth, entitlements, PaidLine{"app_store", 7'000'000'000}, reports, forwarding};
    auto request = drogon::HttpRequest::newHttpJsonRequest(body);
    request->setMethod(drogon::Post);
    request->setPath("/v1/subscription/app-store/claims");
    if (!account.empty()) request->addCookie("wm_session", "s-" + account);
    const WriteRoute route{"/v1/subscription/app-store/claims", "subscription.claim", "platform", "rest", {drogon::Post}};
    auto handler = [&api](const drogon::HttpRequestPtr& incoming, WriteHttpCallback&& reply) {
      api.claimAppStore(incoming, std::move(reply));
    };

    std::size_t before = 0;
    {
      std::lock_guard lock{linesMutex_};
      before = lines_.size();
    }
    drogon::HttpResponsePtr reply;
    detail::ObservedHttpHandler<decltype(&decltype(handler)::operator())>::wrap(route, handler)(
        request, [&reply](const drogon::HttpResponsePtr& response) { reply = response; });
    std::unique_lock lock{linesMutex_};
    if (!written_.wait_for(lock, 20s, [&] { return lines_.size() > before; }))
      throw std::runtime_error("the claim wrote no line within 20 s");
    return {reply, lines_.back()};
  }

private:
  std::mutex linesMutex_;
  std::condition_variable written_;
  std::vector<std::string> lines_;
};

std::string bytesOf(const drogon::HttpResponsePtr& response) {
  return std::string(response->getBody());
}

std::string address(const std::string& account) {
  return "subscriber-" + account + "@example.com";
}

}

// Each example of subscription.json, read at the instant its generator reads it, over the entitlement.json row it was
// made from: the reply is the example, byte for byte as the reply writer writes it, and its `windmillOne` is what
// Entitlements::hasWindmillOne answers for the account then.
TEST(subscription_read_answers_every_contract_example_from_the_copy_s_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  enum class Listed { Nowhere, SandboxTesters, Owners };
  struct Example {
    const char* name;
    const char* entitlement;
    UnixMs now;
    Listed listed;
    const char* purchasableStores;
  };
  const Example examples[] = {
      {"active", "active", 1'796'378'400'000, Listed::Nowhere, "app_store"},                        // T0 + DAY
      {"cancelled_access_continues", "cancelled_access_continues", 1'804'795'200'000, Listed::Nowhere,
       "app_store"},                                                                                 // TURNED_OFF + DAY
      {"grace", "grace", 1'801'821'600'000, Listed::Nowhere, "app_store"},                          // END2 + 2 DAY
      {"on_hold", "on_hold", 1'803'117'600'000, Listed::Nowhere, "app_store"},                      // GRACE_ENDS + DAY
      {"expired_line_open", "expired", 1'805'810'400'000, Listed::Nowhere, "app_store"},            // END3 + DAY
      {"revoked_line_open", "revoked", 1'797'867'000'000, Listed::Nowhere, "app_store"},            // Q1_REFUNDED + DAY
      {"never_subscribed_line_open", "never_subscribed", 1'806'667'200'000, Listed::Nowhere, "app_store"},  // ERASED + DAY
      {"allowlisted_never_subscribed_line_open", "never_subscribed", 1'806'667'200'000, Listed::SandboxTesters,
       "app_store"},
      {"never_subscribed_line_closed", "never_subscribed", 1'806'667'200'000, Listed::Nowhere, ""},
      {"owner_line_open", "never_subscribed", 1'806'667'200'000, Listed::Owners, "app_store"},
      {"charged_twice", "charged_twice", 1'797'069'600'000, Listed::Nowhere, "app_store"},          // 2026-12-12T10:00
      {"sandbox_allowlisted", "sandbox_active_production_expired", 1'799'766'120'000, Listed::SandboxTesters,
       "app_store"},                                                                                 // + 2 MINUTE
      {"sandbox_not_allowlisted_line_open", "sandbox_active_production_expired", 1'799'766'120'000, Listed::Nowhere,
       "app_store"},
  };
  Door door;
  std::vector<std::string> named;
  std::vector<std::string> served;
  std::vector<std::string> agreed;
  for (const Example& example : examples) {
    named.push_back(example.name);
    Door::sql("DELETE FROM account_entitlements");
    const Json::Value entitlement = entitlementExample(example.entitlement);
    door.seed(entitlement);
    door.clock.now = example.now;
    const std::string account = entitlement["accountId"].asString();
    const Allowlists lists{.owners = EmailList{example.listed == Listed::Owners ? address(account) : ""},
                           .sandboxTesters = EmailList{example.listed == Listed::SandboxTesters ? address(account) : ""}};
    const Entitlements entitlements{door.copy, door.clock, door.usage, lists};

    const drogon::HttpResponsePtr reply = door.read(account, lists, example.purchasableStores);
    REQUIRE(reply);
    const Json::Value expected = contractExample("subscription.json", example.name)["body"];
    CHECK_EQ(reply->getStatusCode(), drogon::k200OK);
    CHECK_EQ(reply->getHeader("cache-control"), std::string("no-store"));
    CHECK(parseWhole(bytesOf(reply)) == std::optional<Json::Value>(expected));
    if (bytesOf(reply) == bytesOf(jsonResponse(expected))) served.push_back(example.name);
    if (expected["windmillOne"] == Json::Value(entitlements.hasWindmillOne(UserId{account}, address(account))))
      agreed.push_back(example.name);
  }
  CHECK(served == named);
  CHECK(agreed == named);
  CHECK(door.reports->seen.empty());
}

// The live copy holds no row until the service serves its feed: every account reads as one that never subscribed, with
// nothing to buy while every store is closed, and an owner as holding Windmill One with no plan.
TEST(subscription_read_of_an_account_with_no_row_answers_no_plan_and_windmill_one_only_to_an_owner) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  const std::string account = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61";
  const std::string owner = bytesOf(jsonResponse(contractExample("subscription.json", "owner_line_open")["body"]));

  CHECK_EQ(bytesOf(door.read(account, {}, "")),
           bytesOf(jsonResponse(contractExample("subscription.json", "never_subscribed_line_closed")["body"])));
  CHECK_EQ(bytesOf(door.read(account, {}, "app_store")),
           bytesOf(jsonResponse(contractExample("subscription.json", "never_subscribed_line_open")["body"])));
  // An owner holds Windmill One, so nothing is offered to buy even on an open line (INV-12).
  CHECK_EQ(bytesOf(door.read(account, {.owners = EmailList{address(account)}}, "")), owner);
  CHECK_EQ(bytesOf(door.read(account, {.owners = EmailList{address(account)}}, "app_store")), owner);
}

TEST(subscription_read_refuses_a_caller_who_is_not_signed_in) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  const drogon::HttpResponsePtr reply = door.read("", {}, "app_store");
  CHECK_EQ(reply->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(bytesOf(reply), bytesOf(error(drogon::k401Unauthorized, "sign in first")));
}

// A copy that cannot be read is a failure the server reports, and the device is told the read is unavailable, an owner's
// device too: the response shows the copy's Entitlement, which an owner's access does not need.
TEST(subscription_read_reports_a_copy_it_cannot_read) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  const std::string account = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61";
  Door::sql("INSERT INTO account_entitlements (account_id, entitlement, seq) VALUES ('" + account + "', '[]', 1)");
  const std::string unavailable = bytesOf(error(drogon::k503ServiceUnavailable, "Your subscription can't be read right now.",
                                                "subscription_unavailable"));

  const drogon::HttpResponsePtr reply = door.read(account, {}, "");
  const drogon::HttpResponsePtr ownerReply = door.read(account, {.owners = EmailList{address(account)}}, "");
  CHECK_EQ(reply->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(bytesOf(reply), unavailable);
  CHECK_EQ(ownerReply->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(bytesOf(ownerReply), unavailable);
  CHECK(door.reports->seen == (std::vector<std::string>{"platform subscription.read", "platform subscription.read"}));
  Door::sql("DELETE FROM account_entitlements");
}

// The feed's claim (app-store-claim.json): the service binds the subscription to the caller and answers the claim's seq,
// the follower brings the copy to it, and the device is answered from the copy, which every gate reads. The account is
// the caller's session's, whatever the body names, and a claim made again answers alike.
TEST(subscription_claim_answers_the_callers_subscription_once_the_follower_brings_the_copy_to_the_claim) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  door.serveTheLedgerToTheClaim();
  door.follower->start();
  door.clock.now = 1'796'547'660'000;  // CLAIMED + MINUTE
  const std::string claimant = "9387ec65-ab17-4b8c-b145-fd0d622966db";
  Json::Value request = contractFile("app-store-claim.json")["request"];
  request["accountId"] = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61";

  door.service->answers("bound_to_caller");
  const Claimed bound = door.claim(claimant, request);
  door.service->answers("already_bound_to_caller");
  const Claimed again = door.claim(claimant, request);

  for (const auto& [claimed, name] : {std::pair{bound, "bound_to_caller"}, std::pair{again, "already_bound_to_caller"}}) {
    const Json::Value example = contractExample("app-store-claim.json", name);
    REQUIRE(claimed.reply);
    CHECK_EQ(static_cast<int>(claimed.reply->getStatusCode()), example["status"].asInt());
    CHECK_EQ(claimed.reply->getHeader("cache-control"), std::string("no-store"));
    CHECK_EQ(bytesOf(claimed.reply), bytesOf(jsonResponse(example["body"])));
    CHECK_EQ(claimed.line, std::string("ok/info platform rest"));
  }
  const std::string signedTransaction = request["signedTransaction"].asString();
  CHECK(door.service->asked() == (std::vector<std::pair<std::string, std::string>>{{claimant, signedTransaction},
                                                                                    {claimant, signedTransaction}}));
  CHECK(door.reports->seen.empty());
}

// A follower that does not bring the copy to the claim within the door's wait: the device is answered from the copy as
// it stands, which holds nothing of the claim yet, and the line says the copy was behind.
TEST(subscription_claim_answers_the_copy_as_it_stands_once_the_wait_for_the_follower_runs_out) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  door.follower->start();
  door.clock.now = 1'796'547'660'000;  // CLAIMED + MINUTE
  door.service->answers("bound_to_caller");

  const Claimed claimed =
      door.claim("9387ec65-ab17-4b8c-b145-fd0d622966db", contractFile("app-store-claim.json")["request"], true, 200ms);
  REQUIRE(claimed.reply);
  CHECK_EQ(static_cast<int>(claimed.reply->getStatusCode()), 200);
  CHECK_EQ(bytesOf(claimed.reply), bytesOf(jsonResponse(contractExample("app-store-claim.json", "copy_behind")["body"])));
  CHECK_EQ(claimed.line, std::string("copy_behind/warn platform rest"));
  CHECK(door.reports->seen.empty());
}

// Each refusal of the service's claim door, answered to the device as app-store-claim.json pins it: every 503 as one,
// and a claim by an account erased meanwhile as its session's next request is. Its line names the service's code, a
// refusal and never an Issue.
TEST(subscription_claim_answers_each_refusal_of_the_service_as_the_contract_pins_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  const std::string unauthenticated = bytesOf(error(drogon::k401Unauthorized, "sign in first"));
  const auto publicly = [](const char* name) {
    const Json::Value example = contractExample("app-store-claim.json", name);
    return std::to_string(example["status"].asInt()) + " " + bytesOf(jsonResponse(example["body"]));
  };
  const std::vector<std::pair<std::string, std::string>> refusals{
      {"bound_to_another_account", publicly("bound_to_another_account")},
      {"transaction_not_verified", publicly("transaction_not_verified")},
      {"ledger_unavailable", publicly("service_unavailable")},
      {"store_unavailable", publicly("service_unavailable")},
      {"store_api_unavailable", publicly("service_unavailable")},
      {"account_erased", "401 " + unauthenticated}};

  std::vector<std::string> answered;
  std::vector<std::string> expected;
  for (const auto& [internal, device] : refusals) {
    door.service->answers(internal);
    const Claimed claimed = door.claim("9387ec65-ab17-4b8c-b145-fd0d622966db", contractFile("app-store-claim.json")["request"]);
    answered.push_back(std::to_string(static_cast<int>(claimed.reply->getStatusCode())) + " " + bytesOf(claimed.reply) +
                       " " + claimed.line);
    expected.push_back(device + " " + contractExample("internal-app-store-claim.json", internal)["body"]["code"].asString() +
                       "/warn platform rest");
  }
  CHECK(answered == expected);
  CHECK(door.reports->seen.empty());
}

// A service that gives no answer the contract describes, and a copy that cannot be read once the service applied the
// claim: each is a failure reported under the claim's operation, and the device is told to claim again later.
TEST(subscription_claim_reports_what_it_cannot_answer_and_tells_the_device_to_claim_again_later) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  const std::string claimant = "9387ec65-ab17-4b8c-b145-fd0d622966db";
  const Json::Value request = contractFile("app-store-claim.json")["request"];
  const std::string later = bytesOf(jsonResponse(contractExample("app-store-claim.json", "service_unavailable")["body"]));

  door.service->answer = []() -> ClaimAnswer { throw ClaimUnanswered("timeout"); };
  const Claimed unanswered = door.claim(claimant, request);
  door.service->answers("bound_to_caller");
  Door::sql("INSERT INTO account_entitlements (account_id, entitlement, seq) VALUES ('" + claimant + "', '[]', 1)");
  const Claimed unreadable = door.claim(claimant, request, true, 0ms);

  for (const Claimed& claimed : {unanswered, unreadable}) {
    CHECK_EQ(static_cast<int>(claimed.reply->getStatusCode()), 503);
    CHECK_EQ(bytesOf(claimed.reply), later);
    CHECK_EQ(claimed.line, std::string("failed/error platform rest"));
  }
  CHECK(door.reports->seen == (std::vector<std::string>{"platform subscription.claim", "platform subscription.claim"}));
}

// What the door refuses before the service is asked: a caller not signed in, a body that holds no signed transaction,
// a claim while the follower is off, and one the claim's threads cannot take.
TEST(subscription_claim_refuses_before_asking_the_service) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  const std::string claimant = "9387ec65-ab17-4b8c-b145-fd0d622966db";
  const Json::Value request = contractFile("app-store-claim.json")["request"];
  const std::string notVerified =
      "400 " + bytesOf(jsonResponse(contractExample("app-store-claim.json", "transaction_not_verified")["body"]));
  const std::string later = "503 " + bytesOf(jsonResponse(contractExample("app-store-claim.json", "service_unavailable")["body"]));
  const auto told = [](const Claimed& claimed) {
    return std::to_string(static_cast<int>(claimed.reply->getStatusCode())) + " " + bytesOf(claimed.reply) + " " +
           claimed.line;
  };
  Json::Value notAString(Json::objectValue);
  notAString["signedTransaction"] = 7;
  Json::Value empty(Json::objectValue);
  empty["signedTransaction"] = "";
  Json::Value tooLong(Json::objectValue);
  tooLong["signedTransaction"] = std::string(SubscriptionApi::kSignedTransactionBytes + 1, 'e');
  Json::Value accountOnly(Json::objectValue);
  accountOnly["accountId"] = claimant;

  CHECK_EQ(told(door.claim("", request)), "401 " + bytesOf(error(drogon::k401Unauthorized, "sign in first")) +
                                              " http_401/warn platform rest");
  for (const Json::Value& body : {Json::Value(Json::objectValue), Json::Value(Json::arrayValue), notAString, empty,
                                  tooLong, accountOnly})
    CHECK_EQ(told(door.claim(claimant, body)), notVerified + " malformed/warn platform rest");
  CHECK_EQ(told(door.claim(claimant, request, false)), later + " unconfigured/warn platform rest");
  door.workers->stopAndJoin();
  CHECK_EQ(told(door.claim(claimant, request)), later + " busy/warn platform rest");
  CHECK(door.service->asked().empty());
  CHECK(door.reports->seen.empty());
}
