#include "platform/subscriptions/SubscriptionApi.h"

#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/subscriptions/PgEntitlementCopy.h"
#include "test/PgTestPool.h"
#include "test/platform/Fakes.h"
#include "test/platform/subscriptions/FeedFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

// GET /v1/subscription over the Postgres copy (RUNNING.md §7): every case needs WM_PG_TEST and skips without it.
using namespace wm;
using namespace wm::subscriptions;
using namespace wm::subscriptions::test;

namespace {

struct Reports : FailureReporter {
  std::vector<std::string> seen;
  void report(const std::string& kind, const std::string& operation, const std::string&) override {
    seen.push_back(kind + " " + operation);
  }
};

// The server's read as main.cpp composes it, over the copy's rows and `clock`, the one access is read against, which the
// case sets. Sessions keep a clock of their own, so a case that moves `clock` years ahead signs no one out. Each account
// signs in with the session secret "s-" + its id.
struct Reader {
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

  Reader() {
    sql("DELETE FROM account_entitlements");
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
};

std::string bytesOf(const drogon::HttpResponsePtr& response) {
  return std::string(response->getBody());
}

std::string address(const std::string& account) {
  return "subscriber-" + account + "@example.com";
}

}

// Each example of subscription.json, read at the instant its generator reads it, over the entitlement.json row it was
// made from: the reply is the example, byte for byte as the reply writer writes it.
TEST(subscription_read_answers_every_contract_example_from_the_copy_s_row) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  struct Example {
    const char* name;
    const char* entitlement;
    UnixMs now;
    bool allowlisted;
    const char* purchasableStores;
  };
  const Example examples[] = {
      {"active", "active", 1'796'378'400'000, false, "app_store"},                                  // T0 + DAY
      {"cancelled_access_continues", "cancelled_access_continues", 1'804'795'200'000, false, "app_store"},  // TURNED_OFF + DAY
      {"grace", "grace", 1'801'821'600'000, false, "app_store"},                                    // END2 + 2 DAY
      {"on_hold", "on_hold", 1'803'117'600'000, false, "app_store"},                                // GRACE_ENDS + DAY
      {"expired_line_open", "expired", 1'805'810'400'000, false, "app_store"},                      // END3 + DAY
      {"revoked_line_open", "revoked", 1'797'867'000'000, false, "app_store"},                      // Q1_REFUNDED + DAY
      {"never_subscribed_line_open", "never_subscribed", 1'806'667'200'000, false, "app_store"},    // ERASED + DAY
      {"allowlisted_never_subscribed_line_open", "never_subscribed", 1'806'667'200'000, true, "app_store"},
      {"never_subscribed_line_closed", "never_subscribed", 1'806'667'200'000, false, ""},
      {"charged_twice", "charged_twice", 1'797'069'600'000, false, "app_store"},                    // 2026-12-12T10:00
      {"sandbox_allowlisted", "sandbox_active_production_expired", 1'799'766'120'000, true, "app_store"},  // + 2 MINUTE
      {"sandbox_not_allowlisted_line_open", "sandbox_active_production_expired", 1'799'766'120'000, false, "app_store"},
  };
  Reader reader;
  std::vector<std::string> named;
  std::vector<std::string> served;
  for (const Example& example : examples) {
    named.push_back(example.name);
    Reader::sql("DELETE FROM account_entitlements");
    const Json::Value entitlement = entitlementExample(example.entitlement);
    reader.seed(entitlement);
    reader.clock.now = example.now;
    const std::string account = entitlement["accountId"].asString();
    const Allowlists lists{.sandboxTesters = EmailList{example.allowlisted ? address(account) : ""}};

    const drogon::HttpResponsePtr reply = reader.read(account, lists, example.purchasableStores);
    REQUIRE(reply);
    const Json::Value expected = contractExample("subscription.json", example.name)["body"];
    CHECK_EQ(reply->getStatusCode(), drogon::k200OK);
    CHECK_EQ(reply->getHeader("cache-control"), std::string("no-store"));
    CHECK(parseWhole(bytesOf(reply)) == std::optional<Json::Value>(expected));
    if (bytesOf(reply) == bytesOf(jsonResponse(expected))) served.push_back(example.name);
  }
  CHECK(served == named);
  CHECK(reader.reports->seen.empty());
}

// The live copy holds no row until the service serves its feed: every account reads as one that never subscribed, with
// nothing to buy while every store is closed, and an owner the same.
TEST(subscription_read_of_an_account_with_no_row_answers_no_plan_and_nothing_to_buy) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Reader reader;
  const std::string account = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61";
  const std::string closed = bytesOf(jsonResponse(contractExample("subscription.json", "never_subscribed_line_closed")["body"]));

  CHECK_EQ(bytesOf(reader.read(account, {}, "")), closed);
  CHECK_EQ(bytesOf(reader.read(account, {.owners = EmailList{address(account)}}, "")), closed);
  // An owner holds Windmill One, so nothing is offered to buy even on an open line (INV-12).
  CHECK_EQ(bytesOf(reader.read(account, {.owners = EmailList{address(account)}}, "app_store")), closed);
  CHECK_EQ(bytesOf(reader.read(account, {}, "app_store")),
           bytesOf(jsonResponse(contractExample("subscription.json", "never_subscribed_line_open")["body"])));
}

TEST(subscription_read_refuses_a_caller_who_is_not_signed_in) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Reader reader;
  const drogon::HttpResponsePtr reply = reader.read("", {}, "app_store");
  CHECK_EQ(reply->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(bytesOf(reply), bytesOf(error(drogon::k401Unauthorized, "sign in first")));
}

// A copy that cannot be read is a failure the server reports, and the device is told the read is unavailable.
TEST(subscription_read_reports_a_copy_it_cannot_read) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  Reader reader;
  const std::string account = "3f6c2a1e-9b7d-4e2a-8c51-0d4f7b2e9a61";
  Reader::sql("INSERT INTO account_entitlements (account_id, entitlement, seq) VALUES ('" + account + "', '[]', 1)");
  const drogon::HttpResponsePtr reply = reader.read(account, {}, "");
  CHECK_EQ(reply->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ((*reply->getJsonObject())["code"].asString(), std::string("subscription_unavailable"));
  CHECK(reader.reports->seen == std::vector<std::string>{"platform subscription.read"});
  Reader::sql("DELETE FROM account_entitlements");
}
