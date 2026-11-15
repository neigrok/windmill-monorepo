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

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <functional>
#include <map>
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
  std::vector<std::string> details;
  void report(const std::string& kind, const std::string& operation, const std::string& detail) override {
    std::lock_guard lock{mutex};
    seen.push_back(kind + " " + operation);
    details.push_back(operation + " " + detail);
  }
  std::mutex mutex;
};

// Where a fake service holds a claim until the case opens it, or 20 s pass.
class Gate {
public:
  void pass() {
    std::unique_lock lock{mutex_};
    opened_.wait_for(lock, 20s, [&] { return open_; });
  }
  void open() {
    {
      std::lock_guard lock{mutex_};
      open_ = true;
    }
    opened_.notify_all();
  }

private:
  std::mutex mutex_;
  std::condition_variable opened_;
  bool open_ = false;
};

// The service's claim door, answering each claim of an account with `answer`, which may hold it at a Gate. Every claim
// it is asked is kept, in order, with how many claims of one account were with it at once.
struct FakeClaims : AppStoreClaims {
  std::function<ClaimAnswer(const std::string& account)> answer;

  // Answers what internal-app-store-claim.json pins under `name`.
  void answers(const std::string& name) {
    const Json::Value example = contractExample("internal-app-store-claim.json", name);
    answer = [example](const std::string&) { return ClaimAnswer{example["status"].asInt(), dump(example["body"])}; };
  }

  std::vector<std::pair<std::string, std::string>> asked() {
    std::lock_guard lock{mutex_};
    return asked_;
  }

  std::size_t mostAtOnce(const std::string& account) {
    std::lock_guard lock{mutex_};
    return mostAtOnce_[account];
  }

  // Waits at most 20 s for the service to have been asked `count` claims.
  void waitAsked(std::size_t count) {
    std::unique_lock lock{mutex_};
    if (!askedMore_.wait_for(lock, 20s, [&] { return asked_.size() >= count; }))
      throw std::runtime_error("the service was not asked within 20 s");
  }

  ClaimAnswer claim(const UserId& account, const SignedTransaction& signedTransaction) override {
    {
      std::lock_guard lock{mutex_};
      asked_.emplace_back(account.str(), signedTransaction.text());
      mostAtOnce_[account.str()] = std::max(mostAtOnce_[account.str()], ++atOnce_[account.str()]);
    }
    askedMore_.notify_all();
    const auto leave = [&] {
      std::lock_guard lock{mutex_};
      --atOnce_[account.str()];
    };
    try {
      ClaimAnswer answered = answer(account.str());
      leave();
      return answered;
    } catch (...) {
      leave();
      throw;
    }
  }

private:
  std::mutex mutex_;
  std::condition_variable askedMore_;
  std::vector<std::pair<std::string, std::string>> asked_;
  std::map<std::string, std::size_t> atOnce_;
  std::map<std::string, std::size_t> mostAtOnce_;
};

// What a claim came to: the device's answer and the claim's one line, as `outcome/level product door`.
struct Claimed {
  drogon::HttpResponsePtr reply;
  std::string line;
};

// A claim sent and not yet answered: its request id names its line.
struct Sent {
  std::shared_ptr<drogon::HttpResponsePtr> reply;
  std::string requestId;
};

// The server's subscription doors as main.cpp composes them, over the copy's rows and `clock`, the one access is read
// against, which the case sets. Sessions keep a clock of their own, so a case that moves `clock` years ahead signs no
// one out. Each account signs in with the session secret "s-" + its id. A claim goes to `service` and waits on
// `follower`, which follows `feed` once a case starts it, on `workers`; the door's clock runs `ahead` of the steady
// clock, and `stopping` is the process's. A case sets them before its first claim, which builds the door.
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
  std::shared_ptr<WorkerPool> workers = std::make_shared<WorkerPool>("subscription-claim", 2, 8);
  std::chrono::milliseconds wait = 5s;
  std::atomic<std::chrono::steady_clock::rep> ahead{0};
  std::atomic<bool> stopping{false};

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
      lines_[line.requestId] = line.outcome + "/" + level + " " + line.product + " " + line.door;
      written_.notify_all();
    });
  }

  ~Door() {
    workers->stopAndJoin();
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

  // The body a phone posts for its `n`th signed transaction, a compact JWS.
  static Json::Value transaction(int n) {
    Json::Value body(Json::objectValue);
    body["signedTransaction"] = "eyJhbGciOiJFUzI1NiIsIng1YyI6W119.eyJ0cmFuc2FjdGlvbklkIjoi" + std::to_string(n) + "In0.c2lnbmF0dXJl";
    return body;
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

  // A claim of `body` through the write route main.cpp registers, on the line open on the App Store, to the door that
  // follows the feed, or, `following` false, the one whose follower is off.
  Sent send(const std::string& account, const Json::Value& body, bool following = true) {
    SubscriptionApi& api = following ? followingDoor() : offDoor();
    auto request = drogon::HttpRequest::newHttpJsonRequest(body);
    request->setMethod(drogon::Post);
    request->setPath("/v1/subscription/app-store/claims");
    if (!account.empty()) request->addCookie("wm_session", "s-" + account);
    const WriteRoute route{"/v1/subscription/app-store/claims", "subscription.claim", "platform", "rest", {drogon::Post}};
    auto handler = [&api](const drogon::HttpRequestPtr& incoming, WriteHttpCallback&& reply) {
      api.claimAppStore(incoming, std::move(reply));
    };
    auto reply = std::make_shared<drogon::HttpResponsePtr>();
    beginWriteRequest(request, route);
    const std::string requestId = beginWriteRequest(request)->requestId();
    detail::ObservedHttpHandler<decltype(&decltype(handler)::operator())>::wrap(route, handler)(
        request, [reply](const drogon::HttpResponsePtr& response) { *reply = response; });
    return {reply, requestId};
  }

  // The claim's answer once its line is written, which may be on the claim's own thread, within 20 s.
  Claimed await(const Sent& sent) {
    std::unique_lock lock{linesMutex_};
    if (!written_.wait_for(lock, 20s, [&] { return lines_.count(sent.requestId) > 0; }))
      throw std::runtime_error("the claim wrote no line within 20 s");
    return {*sent.reply, lines_.at(sent.requestId)};
  }

  Claimed claim(const std::string& account, const Json::Value& body, bool following = true) {
    return await(send(account, body, following));
  }

private:
  SubscriptionApi& followingDoor() {
    if (!following_)
      following_ = std::make_unique<SubscriptionApi>(
          auth, std::make_shared<Entitlements>(copy, clock, usage, Allowlists{}), PaidLine{"app_store", 7'000'000'000},
          reports,
          ClaimForwarding{service, follower, workers, [this] { return stopping.load(); }, wait,
                          [this] { return std::chrono::steady_clock::now() + std::chrono::steady_clock::duration{ahead.load()}; }});
    return *following_;
  }

  SubscriptionApi& offDoor() {
    if (!off_)
      off_ = std::make_unique<SubscriptionApi>(auth, std::make_shared<Entitlements>(copy, clock, usage, Allowlists{}),
                                               PaidLine{"app_store", 7'000'000'000}, reports);
    return *off_;
  }

  std::unique_ptr<SubscriptionApi> following_;
  std::unique_ptr<SubscriptionApi> off_;
  std::mutex linesMutex_;
  std::condition_variable written_;
  std::map<std::string, std::string> lines_;
};

std::string bytesOf(const drogon::HttpResponsePtr& response) {
  return std::string(response->getBody());
}

std::string address(const std::string& account) {
  return "subscriber-" + account + "@example.com";
}

// A claim's answer and line on one line: status, body bytes and `outcome/level product door`.
std::string told(const Claimed& claimed) {
  return std::to_string(static_cast<int>(claimed.reply->getStatusCode())) + " " + bytesOf(claimed.reply) + " " +
         claimed.line;
}

// What app-store-claim.json pins under `name`, as `told` writes it, before the line.
std::string pinned(const char* name) {
  const Json::Value example = contractExample("app-store-claim.json", name);
  return std::to_string(example["status"].asInt()) + " " + bytesOf(jsonResponse(example["body"]));
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
  Json::Value request = Door::transaction(1);
  request["accountId"] = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61";

  door.service->answers("bound_to_caller");
  const Claimed bound = door.claim(claimant, request);
  door.service->answers("already_bound_to_caller");
  const Claimed again = door.claim(claimant, request);

  CHECK_EQ(told(bound), pinned("bound_to_caller") + " ok/info platform rest");
  CHECK_EQ(told(again), pinned("already_bound_to_caller") + " ok/info platform rest");
  CHECK_EQ(bound.reply->getHeader("cache-control"), std::string("no-store"));
  const std::string signedTransaction = request["signedTransaction"].asString();
  CHECK(door.service->asked() == (std::vector<std::pair<std::string, std::string>>{{claimant, signedTransaction},
                                                                                    {claimant, signedTransaction}}));
  CHECK(door.reports->seen.empty());
}

// A claim the service recorded and the follower does not bring the copy to within the door's wait: 202, the copy as it
// stands, which holds nothing of the claim yet, and nothing to buy beside it (INV-12).
TEST(subscription_claim_answers_202_offering_nothing_once_the_wait_for_the_follower_runs_out) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  door.wait = 200ms;
  door.follower->start();
  door.clock.now = 1'796'547'660'000;  // CLAIMED + MINUTE
  door.service->answers("bound_to_caller");

  const Claimed claimed = door.claim("9387ec65-ab17-4b8c-b145-fd0d622966db", Door::transaction(1));
  CHECK_EQ(told(claimed), pinned("recorded_copy_behind") + " copy_behind/warn platform rest");
  CHECK(door.reports->seen.empty());
}

// The service answers a seq past the newest event its ledger reports while the copy is caught up with it: the claim
// answers 202, and the seq that will never be reached is one Issue per window, however many claims meet it.
TEST(subscription_claim_reports_a_seq_past_the_ledger_once_per_window) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  door.wait = 300ms;
  door.serveTheLedgerToTheClaim();
  door.follower->start();
  door.clock.now = 1'796'547'660'000;  // CLAIMED + MINUTE
  door.service->answer = [](const std::string&) { return ClaimAnswer{200, R"({"seq":999,"entitlement":{}})"}; };

  const Claimed first = door.claim("9387ec65-ab17-4b8c-b145-fd0d622966db", Door::transaction(1));
  const Claimed second = door.claim("9387ec65-ab17-4b8c-b145-fd0d622966db", Door::transaction(2));
  for (const Claimed& claimed : {first, second}) {
    CHECK_EQ(static_cast<int>(claimed.reply->getStatusCode()), 202);
    CHECK_EQ(claimed.line, std::string("copy_behind/warn platform rest"));
  }
  CHECK(door.reports->details == (std::vector<std::string>{"subscription.claim.seq_unreached cause=past_the_ledger"}));
}

// Each refusal of the service's claim door, answered to the device as app-store-claim.json pins it: every 503 as one,
// the request the service gave up on itself included, a body it would not read as a transaction that does not verify,
// and a claim by an account erased meanwhile as its session's next request is. Its line names the refusal, never an
// Issue, but for the body the two sides no longer agree on.
TEST(subscription_claim_answers_each_refusal_of_the_service_as_the_contract_pins_it) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  const std::string unauthenticated = "401 " + bytesOf(error(drogon::k401Unauthorized, "sign in first"));
  const auto answering = [](int status, std::string body) {
    return [status, body](const std::string&) { return ClaimAnswer{status, body}; };
  };
  const auto pinnedRefusal = [](const char* name) {
    return std::function<ClaimAnswer(const std::string&)>{[example = contractExample("internal-app-store-claim.json", name)](
                                                              const std::string&) {
      return ClaimAnswer{example["status"].asInt(), dump(example["body"])};
    }};
  };
  const std::vector<std::pair<std::function<ClaimAnswer(const std::string&)>, std::string>> refusals{
      {pinnedRefusal("bound_to_another_account"), pinned("bound_to_another_account") + " bound_to_another_account/warn"},
      {pinnedRefusal("transaction_not_verified"), pinned("transaction_not_verified") + " invalid_transaction/warn"},
      {pinnedRefusal("ledger_unavailable"), pinned("service_unavailable") + " unavailable/warn"},
      {pinnedRefusal("store_unavailable"), pinned("service_unavailable") + " store_unavailable/warn"},
      {pinnedRefusal("store_api_unavailable"), pinned("service_unavailable") + " store_api_unavailable/warn"},
      {answering(503, R"({"error":"timeout"})"), pinned("service_unavailable") + " timeout/warn"},
      {answering(413, "length limit exceeded"), pinned("transaction_not_verified") + " too_large/warn"},
      {pinnedRefusal("account_erased"), unauthenticated + " account_erased/warn"}};

  std::vector<std::string> answered;
  std::vector<std::string> expected;
  for (const auto& [answer, device] : refusals) {
    door.service->answer = answer;
    answered.push_back(told(door.claim("9387ec65-ab17-4b8c-b145-fd0d622966db", Door::transaction(1))));
    expected.push_back(device + " platform rest");
  }
  CHECK(answered == expected);
  CHECK(door.reports->details == (std::vector<std::string>{"subscription.claim.unanswered answer=413"}));
}

// A service that gives no answer the contract describes: the device is told to claim again later, the line names the
// answer, and each answer is one Issue per window, so no caller spends the process's reports. A copy that cannot be read
// once the service applied the claim is a failure of the claim's own.
TEST(subscription_claim_names_what_it_cannot_answer_and_reports_each_answer_once_per_window) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  door.wait = 0ms;
  const std::string claimant = "9387ec65-ab17-4b8c-b145-fd0d622966db";
  const std::string later = pinned("service_unavailable");
  std::vector<std::string> answers;

  for (const char* answer : {"timeout", "timeout", "502"}) {
    door.service->answer = [answer](const std::string&) -> ClaimAnswer { throw ClaimUnanswered(answer); };
    answers.push_back(told(door.claim(claimant, Door::transaction(1))));
  }
  door.service->answers("bound_to_caller");
  Door::sql("INSERT INTO account_entitlements (account_id, entitlement, seq) VALUES ('" + claimant + "', '[]', 1)");
  answers.push_back(told(door.claim(claimant, Door::transaction(1))));

  CHECK(answers == (std::vector<std::string>{later + " unanswered_timeout/warn platform rest",
                                           later + " unanswered_timeout/warn platform rest",
                                           later + " unanswered_502/warn platform rest",
                                           later + " failed/error platform rest"}));
  REQUIRE_EQ(door.reports->details.size(), std::size_t{3});
  CHECK(std::vector<std::string>(door.reports->details.begin(), door.reports->details.begin() + 2) ==
        (std::vector<std::string>{"subscription.claim.unanswered answer=timeout", "subscription.claim.unanswered answer=502"}));
  CHECK(door.reports->seen == (std::vector<std::string>{"platform subscription.claim.unanswered",
                                                        "platform subscription.claim.unanswered",
                                                        "platform subscription.claim"}));
}

// What the door refuses before the service is asked: a caller not signed in, a body that holds no compact JWS of at
// most SignedTransaction::kBytes, a claim while the follower is off, and one the claim's threads cannot take.
TEST(subscription_claim_refuses_before_asking_the_service) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  const std::string claimant = "9387ec65-ab17-4b8c-b145-fd0d622966db";
  const std::string notVerified = pinned("transaction_not_verified");
  const std::string later = pinned("service_unavailable");
  const std::string segment((SignedTransaction::kBytes - 2) / 3, 'e');
  const std::string pastTheBound = segment + "." + segment + "." + std::string(SignedTransaction::kBytes - 1 - 2 * segment.size(), 'e');
  std::vector<Json::Value> bodies{Json::Value(Json::objectValue), Json::Value(Json::arrayValue)};
  for (const Json::Value& sent : {Json::Value(7), Json::Value(""), Json::Value("tx-1"), Json::Value("a.b"),
                                  Json::Value("a..b"), Json::Value(".a.b"), Json::Value("a.b."), Json::Value("a.b.c.d"),
                                  Json::Value("a.b.c!"), Json::Value("a.b.c="), Json::Value("a.\"b\".c"),
                                  Json::Value("a.\u0001.c"), Json::Value(pastTheBound)}) {
    Json::Value body(Json::objectValue);
    body["signedTransaction"] = sent;
    bodies.push_back(body);
  }
  Json::Value accountOnly(Json::objectValue);
  accountOnly["accountId"] = claimant;
  bodies.push_back(accountOnly);

  CHECK_EQ(told(door.claim("", Door::transaction(1))),
           "401 " + bytesOf(error(drogon::k401Unauthorized, "sign in first")) + " http_401/warn platform rest");
  for (const Json::Value& body : bodies) CHECK_EQ(told(door.claim(claimant, body)), notVerified + " malformed/warn platform rest");
  CHECK_EQ(told(door.claim(claimant, Door::transaction(1), false)), later + " unconfigured/warn platform rest");
  door.workers->stopAndJoin();
  CHECK_EQ(told(door.claim(claimant, Door::transaction(1))), later + " busy/warn platform rest");
  CHECK(door.service->asked().empty());
  CHECK(door.reports->seen.empty());
}

// One claim of an account is with the service at a time and the next waits behind it, up to kClaimsPerAccount taken;
// meanwhile another account's claim is taken at once.
TEST(subscription_claim_takes_one_claim_of_an_account_at_a_time_and_keeps_taking_other_accounts) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  const std::string flooder = "9387ec65-ab17-4b8c-b145-fd0d622966db";
  const std::string bystander = "c806aea4-76c0-4868-acbc-3aa7db2b8dd0";
  Gate gate;
  door.service->answer = [&](const std::string& account) {
    if (account == flooder) gate.pass();
    return ClaimAnswer{409, R"({"code":"bound_to_another_account"})"};
  };

  std::vector<Sent> flooding;
  flooding.push_back(door.send(flooder, Door::transaction(1)));
  door.service->waitAsked(1);
  for (int n = 2; n <= 5; ++n) flooding.push_back(door.send(flooder, Door::transaction(n)));
  const Claimed beyond = door.await(flooding.back());
  const Claimed taken = door.claim(bystander, Door::transaction(9));
  gate.open();
  std::vector<std::string> flooded;
  for (std::size_t n = 0; n + 1 < flooding.size(); ++n) flooded.push_back(told(door.await(flooding[n])));

  CHECK_EQ(told(beyond), pinned("service_unavailable") + " busy/warn platform rest");
  CHECK_EQ(told(taken), pinned("bound_to_another_account") + " bound_to_another_account/warn platform rest");
  CHECK(flooded == std::vector<std::string>(4, pinned("bound_to_another_account") + " bound_to_another_account/warn platform rest"));
  CHECK_EQ(door.service->mostAtOnce(flooder), std::size_t{1});
  std::vector<std::pair<std::string, std::string>> asked;
  for (const auto& [account, n] : {std::pair{flooder, 1}, {bystander, 9}, {flooder, 2}, {flooder, 3}, {flooder, 4}})
    asked.emplace_back(account, Door::transaction(n)["signedTransaction"].asString());
  CHECK(door.service->asked() == asked);
}

// A claim still waiting to be taken past kClaimQueueWait answers at once without asking the service, so every claim is
// answered inside the wait a reply has; and one waiting when the process is told to stop answers at once, each with its
// line.
TEST(subscription_claim_waiting_past_its_queue_wait_or_through_a_stop_answers_without_asking_the_service) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Door door;
  door.workers = std::make_shared<WorkerPool>("subscription-claim", 1, 8);
  const std::string first = "9387ec65-ab17-4b8c-b145-fd0d622966db";
  const std::string second = "c806aea4-76c0-4868-acbc-3aa7db2b8dd0";
  const std::string third = "60eb0e14-f50c-49d6-a496-56ef6c8d4e8e";
  Gate expiring;
  Gate stopping;
  std::atomic<int> calls{0};
  door.service->answer = [&](const std::string&) {
    (calls++ == 0 ? expiring : stopping).pass();
    return ClaimAnswer{409, R"({"code":"bound_to_another_account"})"};
  };
  const std::string refused = pinned("bound_to_another_account") + " bound_to_another_account/warn platform rest";
  const std::string later = pinned("service_unavailable");

  const Sent held = door.send(first, Door::transaction(1));
  door.service->waitAsked(1);
  const Sent queued = door.send(second, Door::transaction(2));
  door.ahead = std::chrono::duration_cast<std::chrono::steady_clock::duration>(kClaimQueueWait + 1s).count();
  expiring.open();
  CHECK_EQ(told(door.await(held)), refused);
  CHECK_EQ(told(door.await(queued)), later + " expired/warn platform rest");

  door.ahead = 0;
  const Sent withTheService = door.send(first, Door::transaction(3));
  door.service->waitAsked(2);
  const Sent behind = door.send(first, Door::transaction(4));
  const Sent another = door.send(third, Door::transaction(5));
  door.stopping = true;
  stopping.open();
  CHECK_EQ(told(door.await(withTheService)), refused);
  CHECK_EQ(told(door.await(behind)), later + " stopping/warn platform rest");
  CHECK_EQ(told(door.await(another)), later + " stopping/warn platform rest");
  CHECK_EQ(door.service->asked().size(), std::size_t{2});
  CHECK(door.reports->seen.empty());
}
