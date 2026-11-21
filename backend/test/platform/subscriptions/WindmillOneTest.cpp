#include "platform/subscriptions/WindmillOne.h"

#include "platform/adapters/json/JsonText.h"
#include "test/platform/subscriptions/FeedFixture.h"
#include "test/testing.h"

#include <string>
#include <vector>

using namespace wm;
using namespace wm::subscriptions;
using namespace wm::subscriptions::test;

namespace {

// The stores a line opens in order, and whether it was given a name it does not know.
std::string stores(const PaidLine& line) {
  std::string listed;
  for (const std::string& store : line.openStores) listed += (listed.empty() ? "" : ",") + store;
  return "[" + listed + "]" + (line.namesUnknownStore ? " unknown" : "");
}

// The parts of a SubscriptionResponse INV-12 rules, and the hold on Windmill One it rules on, on one line.
std::string offered(const Json::Value& body) {
  return "windmillOne=" + dump(body["windmillOne"]) + " purchasable=" + dump(body["purchasable"]) + " offer=" +
         dump(body["offer"]) + " manage=" + dump(body["manage"]);
}

}

// A name the backend does not know, and Paddle, which no surface sells through, opens nothing and is flagged, so a typo
// leaves its store closed and the server serving: the line opens only what it can sell.
TEST(the_paid_line_opens_the_stores_its_variable_names_in_d1_order_and_keeps_an_unknown_one_closed) {
  std::vector<std::string> lines;
  for (const char* typed : {"", " , ", "app_store", " play_store ,app_store, app_store", "play_store,paddle,app_store",
                            "paddle", "appstore", "App_Store", "app_store,google_play", "play_store;app_store"})
    lines.push_back(stores(PaidLine{typed, 0}));
  CHECK(lines == (std::vector<std::string>{"[]", "[]", "[app_store]", "[app_store,play_store]",
                                           "[app_store,play_store] unknown", "[] unknown", "[] unknown", "[] unknown",
                                           "[app_store] unknown", "[] unknown"}));
}

// INV-12: nothing to buy while the account has Windmill One, owners included, while the Entitlement shown holds a
// subscription that has not ended, or while a claim the service recorded has not reached the copy; otherwise every store
// configuration opens, with the offer beside them.
TEST(a_subscription_response_offers_the_open_stores_only_to_an_account_with_nothing_live) {
  const PaidLine open{"app_store", 7'000'000'000};
  const EntitlementResponse never{entitlementExample("never_subscribed")};
  const EntitlementResponse onHold{entitlementExample("on_hold")};
  const EntitlementResponse expired{entitlementExample("expired")};
  const std::int64_t later = 1'806'667'200'000;

  CHECK_EQ(offered(SubscriptionResponse{Standing{false, false, never, later}, open}.body),
           std::string(R"(windmillOne=false purchasable=["app_store"] offer={"aiAllowance":{"amount":"7.00","currency":"USD"}} manage=null)"));
  CHECK_EQ(offered(SubscriptionResponse{Standing{false, false, std::nullopt, later}, open}.body),
           std::string(R"(windmillOne=false purchasable=["app_store"] offer={"aiAllowance":{"amount":"7.00","currency":"USD"}} manage=null)"));
  CHECK_EQ(offered(SubscriptionResponse{Standing{true, false, never, later}, open}.body),
           std::string("windmillOne=true purchasable=[] offer=null manage=null"));
  CHECK_EQ(offered(SubscriptionResponse{Standing{true, false, expired, later}, open}.body),
           std::string(R"(windmillOne=true purchasable=[] offer=null manage={"store":"app_store","url":"https://apps.apple.com/account/subscriptions"})"));
  CHECK_EQ(offered(SubscriptionResponse{Standing{false, false, onHold, later}, open}.body),
           std::string(R"(windmillOne=false purchasable=[] offer=null manage={"store":"app_store","url":"https://apps.apple.com/account/subscriptions"})"));
  CHECK_EQ(offered(SubscriptionResponse{Standing{false, false, expired, later}, PaidLine{"", 7'000'000'000}}.body),
           std::string(R"(windmillOne=false purchasable=[] offer=null manage={"store":"app_store","url":"https://apps.apple.com/account/subscriptions"})"));
  CHECK_EQ(offered(SubscriptionResponse{Standing{false, false, std::nullopt, later, true}, open}.body),
           std::string("windmillOne=false purchasable=[] offer=null manage=null"));
  CHECK_EQ(offered(SubscriptionResponse{Standing{false, false, expired, later, true}, open}.body),
           std::string(R"(windmillOne=false purchasable=[] offer=null manage={"store":"app_store","url":"https://apps.apple.com/account/subscriptions"})"));
}

TEST(a_subscription_response_writes_the_offer_in_usd_minor_units_keeping_any_digit_past_them) {
  const EntitlementResponse never{entitlementExample("never_subscribed")};
  std::vector<std::string> amounts;
  for (const long long nanos : {7'000'000'000LL, 7'500'000'000LL, 7'005'000'000LL, 12'345'678'901LL})
    amounts.push_back(SubscriptionResponse{Standing{false, false, never, 0}, PaidLine{"app_store", nanos}}
                          .body["offer"]["aiAllowance"]["amount"].asString());
  CHECK(amounts == (std::vector<std::string>{"7.00", "7.50", "7.005", "12.345678901"}));
}

// A word the contract does not name yet reads as live, so no account is offered a second subscription beside one the
// backend cannot read; a store with no manage page at a fixed address shows no manage link.
TEST(a_subscription_response_reads_an_unknown_state_as_live_and_links_only_a_store_with_a_manage_page) {
  Json::Value entitlement = entitlementExample("expired");
  entitlement["production"]["governing"]["state"] = "suspended";
  entitlement["production"]["governing"]["store"] = "play_store";
  const Json::Value body = SubscriptionResponse{
      Standing{false, false, EntitlementResponse{entitlement}, 1'806'667'200'000}, PaidLine{"app_store,play_store", 1}}.body;
  CHECK_EQ(offered(body), std::string("windmillOne=false purchasable=[] offer=null manage=null"));
}
