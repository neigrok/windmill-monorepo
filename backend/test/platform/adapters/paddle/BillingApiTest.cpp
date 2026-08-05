#include "platform/adapters/paddle/BillingApi.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <drogon/utils/Utilities.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

// The Paddle webhook's HTTP edge. The signature scheme itself is pinned elsewhere, against a vector
// computed outside this codebase (adapters/paddle/PaddleSignatureTest.cpp) — this file is about what
// the handler does with a delivery it has already accepted.
//
// The case it exists for is `isUuid`. `custom_data` rides in from a checkout anyone can open, so the
// account id in a delivery is untrusted input on its way to a `$3::uuid` bind. A value that is not a
// UUID makes that bind throw, the handler answers non-2xx, and Paddle redelivers the same poison
// payload until its retry budget is gone — taking every later event for that destination with it. An
// unusable id has to read as no binding at all, and nothing else in the repo says so.
using namespace wm;
using namespace wm::fake;

namespace {

const std::string kSecret = "pdl_ntfset_windmill_test_secret";
const std::string kTimestamp = "1700000000";  // the FakeClock's own second
const std::string kAccount = "44444444-4444-4444-4444-444444444444";

// Every write the edge made, in order — the shared FakeSubscriptionRepository keys on the user id,
// which is precisely the field under test, so a rejected binding would land on top of an accepted
// one and the assertion would be testing the fake.
struct RecordingSubscriptions : SubscriptionRepository {
  std::vector<PaddleCustomer> customers;
  std::vector<PaddleSubscription> subscriptions;
  bool dead = false;

  void upsertCustomer(const PaddleCustomer& customer) override {
    if (dead) throw std::runtime_error("that table is on fire");
    customers.push_back(customer);
  }
  void upsertSubscription(const PaddleSubscription& subscription) override {
    if (dead) throw std::runtime_error("that table is on fire");
    subscriptions.push_back(subscription);
  }
  std::optional<PaddleSubscription> findFor(const UserId& user, const std::string&) override {
    for (const PaddleSubscription& row : subscriptions)
      if (row.userId == user.str()) return row;
    return std::nullopt;
  }
};

std::string sign(const std::string& body, const std::string& timestamp) {
  const std::string payload = timestamp + ":" + body;
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int macLength = 0;
  HMAC(EVP_sha256(), kSecret.data(), static_cast<int>(kSecret.size()),
       reinterpret_cast<const unsigned char*>(payload.data()), payload.size(), mac, &macLength);
  std::string hex;
  hex.reserve(macLength * 2);
  static const char* digits = "0123456789abcdef";
  for (unsigned int i = 0; i < macLength; ++i) {
    hex.push_back(digits[mac[i] >> 4]);
    hex.push_back(digits[mac[i] & 0x0F]);
  }
  return "ts=" + timestamp + ";h1=" + hex;
}

struct Harness {
  RecordingSubscriptions subscriptions;
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, *clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth = std::make_shared<AuthService>(
      authRepo, email, tokens, *clock, oauth, footprint, "https://windmill.works");
  BillingApi api{subscriptions, auth, *clock, kSecret};

  UserId signIn(const std::string& sessionSecret, const std::string& address = "sam@example.com") {
    User user = authRepo.createUser(Email{address}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock->now + 1'000'000, "", "",
                           clock->now);
    return user.id;
  }
};

// A subscription.created exactly as Paddle shapes it, with whatever custom_data the case is about.
std::string subscriptionEvent(const std::string& customData,
                              const std::string& status = "active",
                              const std::string& occurredAt = "2026-05-01T10:00:00.000Z") {
  return R"({"event_type":"subscription.created","occurred_at":")" + occurredAt +
         R"(","data":{"id":"sub_1","customer_id":"ctm_1","status":")" + status +
         R"(","custom_data":)" + customData +
         R"(,"items":[{"price":{"id":"pri_1","product_id":"pro_1"}}],)" +
         R"("scheduled_change":{"effective_at":"2026-06-01T00:00:00Z"}}})";
}

std::string boundTo(const std::string& userId) {
  return R"({"user_id":")" + userId + R"("})";
}

drogon::HttpRequestPtr delivery(const std::string& body, const std::string& signature) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/v1/paddle/webhook");
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(body);
  if (!signature.empty()) req->addHeader("paddle-signature", signature);
  return req;
}

drogon::HttpResponsePtr post(Harness& h, const std::string& body) {
  drogon::HttpResponsePtr captured;
  h.api.webhook(delivery(body, sign(body, kTimestamp)),
                [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return captured;
}

drogon::HttpResponsePtr read(Harness& h, const std::string& session) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Get);
  req->setPath("/v1/subscription");
  if (!session.empty()) req->addCookie("wm_session", session);
  drogon::HttpResponsePtr captured;
  h.api.mySubscription(req, [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return captured;
}

}

TEST(billing_webhook_binds_the_account_our_checkout_stamped_on_the_transaction) {
  Harness h;

  const drogon::HttpResponsePtr response = post(h, subscriptionEvent(boundTo(kAccount)));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK((*response->getJsonObject())["received"].asBool());
  REQUIRE(h.subscriptions.subscriptions.size() == 1u);
  const PaddleSubscription& row = h.subscriptions.subscriptions[0];
  CHECK_EQ(row.subscriptionId, std::string("sub_1"));
  CHECK_EQ(row.customerId, std::string("ctm_1"));
  CHECK_EQ(row.userId, kAccount);
  CHECK_EQ(row.status, std::string("active"));
  CHECK_EQ(row.priceId, std::string("pri_1"));
  CHECK_EQ(row.productId, std::string("pro_1"));
  CHECK_EQ(row.scheduledChangeAt, std::string("2026-06-01T00:00:00Z"));
  CHECK_EQ(row.occurredAt, std::string("2026-05-01T10:00:00.000Z"));
}

// The whole point of the hand-rolled check. Every one of these would reach a `::uuid` bind, throw,
// and cost the destination a retry — and then another, and another, until Paddle gives up on the
// endpoint entirely and every LATER event is lost with it. So the delivery is acknowledged and the
// unusable id is simply dropped: the subscription still lands, bound by email instead.
TEST(billing_webhook_a_custom_data_user_id_that_is_not_a_uuid_is_no_binding_and_still_a_200) {
  for (const std::string& claimed :
       {std::string(""),                                       // absent in all but name
        std::string("hello"),                                  // not even close
        std::string("44444444-4444-4444-4444-44444444444"),    // 35 — one short
        std::string("44444444-4444-4444-4444-4444444444444"),  // 37 — one long
        std::string("44444444-4444-4444-4444-44444444444g"),   // a non-hex character
        std::string("444444444-444-4444-4444-444444444444"),   // dashes in the wrong places
        std::string("44444444_4444_4444_4444_444444444444"),   // underscores for dashes
        std::string("{44444444-4444-4444-4444-444444444444}"), // the braced Microsoft form
        std::string("44444444444444444444444444444444"),       // 32 hex, no dashes
        std::string("' OR 1=1 --                          ")}) {
    Harness h;

    const drogon::HttpResponsePtr response = post(h, subscriptionEvent(boundTo(claimed)));

    CHECK_EQ(response->getStatusCode(), drogon::k200OK);
    REQUIRE(h.subscriptions.subscriptions.size() == 1u);
    CHECK_EQ(h.subscriptions.subscriptions[0].userId, std::string(""));
    CHECK_EQ(h.subscriptions.subscriptions[0].status, std::string("active"));
  }
}

// Hex is hex in either case, and Paddle is not the only thing that can put a value in custom_data —
// an id typed in upper case is still the account it names, and refusing it would strand a real
// subscription with no binding at all.
TEST(billing_webhook_an_upper_case_uuid_is_the_same_account) {
  Harness h;
  const std::string upper = "44444444-4444-4444-4444-44444444ABCD";

  CHECK_EQ(post(h, subscriptionEvent(boundTo(upper)))->getStatusCode(), drogon::k200OK);

  REQUIRE(h.subscriptions.subscriptions.size() == 1u);
  CHECK_EQ(h.subscriptions.subscriptions[0].userId, upper);
}

// custom_data is whatever the checkout put there, which is not necessarily an object with a string
// in it. jsoncpp throws on a lookup into a non-object, and a throw here is a 500 and a retry.
TEST(billing_webhook_a_custom_data_of_any_other_shape_is_no_binding_and_still_a_200) {
  for (const std::string& custom : {std::string("null"), std::string("7"), std::string("\"u1\""),
                                    std::string("[]"), std::string("{}"),
                                    std::string(R"({"user_id":7})"),
                                    std::string(R"({"user_id":null})"),
                                    std::string(R"({"account":"44444444-4444-4444-4444-444444444444"})")}) {
    Harness h;

    CHECK_EQ(post(h, subscriptionEvent(custom))->getStatusCode(), drogon::k200OK);

    REQUIRE(h.subscriptions.subscriptions.size() == 1u);
    CHECK_EQ(h.subscriptions.subscriptions[0].userId, std::string(""));
  }
}

TEST(billing_webhook_a_customer_event_mirrors_the_email_that_bridges_to_an_account) {
  Harness h;

  const std::string body =
      R"({"event_type":"customer.created","occurred_at":"2026-05-01T10:00:00.000Z",)"
      R"("data":{"id":"ctm_1","email":"sam@example.com"}})";
  CHECK_EQ(post(h, body)->getStatusCode(), drogon::k200OK);

  REQUIRE(h.subscriptions.customers.size() == 1u);
  CHECK_EQ(h.subscriptions.customers[0].customerId, std::string("ctm_1"));
  CHECK_EQ(h.subscriptions.customers[0].email, std::string("sam@example.com"));
  CHECK(h.subscriptions.subscriptions.empty());
}

// A forged or unsigned delivery must reach no write at all — this endpoint is otherwise a way for
// anyone on the internet to tell us their own subscription is active.
TEST(billing_webhook_an_unverified_delivery_is_refused_and_writes_nothing) {
  Harness h;
  const std::string body = subscriptionEvent(boundTo(kAccount));

  drogon::HttpResponsePtr captured;
  h.api.webhook(delivery(body, "ts=" + kTimestamp + ";h1=" + std::string(64, 'a')),
                [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(captured->getStatusCode(), drogon::k401Unauthorized);

  // A genuine signature over a body that was then edited — the digest covers the exact bytes.
  h.api.webhook(delivery(subscriptionEvent(boundTo(kAccount), "canceled"), sign(body, kTimestamp)),
                [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(captured->getStatusCode(), drogon::k401Unauthorized);

  // No header at all, and no body at all, are each a 400 before the verifier is even reached.
  h.api.webhook(delivery(body, ""), [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(captured->getStatusCode(), drogon::k400BadRequest);
  h.api.webhook(delivery("", sign("", kTimestamp)),
                [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(captured->getStatusCode(), drogon::k400BadRequest);

  CHECK(h.subscriptions.subscriptions.empty());
  CHECK(h.subscriptions.customers.empty());
}

// An unconfigured secret must refuse everything rather than accept everything: an endpoint that
// verified nothing would be strictly worse than no endpoint at all.
TEST(billing_webhook_an_unconfigured_secret_refuses_every_delivery) {
  Harness h;
  BillingApi dark{h.subscriptions, h.auth, *h.clock, ""};

  const std::string body = subscriptionEvent(boundTo(kAccount));
  drogon::HttpResponsePtr captured;
  dark.webhook(delivery(body, sign(body, kTimestamp)),
               [&](const drogon::HttpResponsePtr& r) { captured = r; });

  CHECK_EQ(captured->getStatusCode(), drogon::k401Unauthorized);
  CHECK(h.subscriptions.subscriptions.empty());
}

// Only a 2xx marks an event delivered, so a state change we failed to record must ask for the
// redelivery rather than acknowledge a write that never happened.
TEST(billing_webhook_a_write_that_throws_asks_paddle_to_deliver_it_again) {
  Harness h;
  h.subscriptions.dead = true;

  const drogon::HttpResponsePtr response = post(h, subscriptionEvent(boundTo(kAccount)));

  CHECK_EQ(response->getStatusCode(), drogon::k500InternalServerError);
  CHECK_EQ((*response->getJsonObject())["error"].asString(), std::string("not recorded"));
}

// A shape we merely do not recognise is acknowledged, never retried — and a verified body that is
// not an event at all still has to be a decision rather than an exception out of the handler.
TEST(billing_webhook_a_shape_we_do_not_mirror_is_acknowledged_and_never_retried) {
  Harness h;

  CHECK_EQ(post(h, R"({"event_type":"transaction.paid","data":{"id":"txn_1"}})")->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(post(h, "{}")->getStatusCode(), drogon::k200OK);
  CHECK_EQ(post(h, R"({"event_type":42,"data":7})")->getStatusCode(), drogon::k200OK);
  CHECK(h.subscriptions.subscriptions.empty());
  CHECK(h.subscriptions.customers.empty());

  // Not JSON at all is a 400 — there is nothing to acknowledge.
  CHECK_EQ(post(h, "not json at all")->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, "[1,2,3]")->getStatusCode(), drogon::k400BadRequest);
  CHECK(h.subscriptions.subscriptions.empty());
}

// Every `subscription.*` verb mirrors, because the status is the whole of what we read — a handler
// listing the verbs it knew would silently stop mirroring the day Paddle added one.
TEST(billing_webhook_every_subscription_verb_mirrors_the_status_it_carries) {
  Harness h;

  for (const std::string& verb : {"created", "updated", "activated", "canceled", "paused",
                                  "past_due", "resumed", "trialing", "imported"})
    CHECK_EQ(post(h, R"({"event_type":"subscription.)" + verb +
                       R"(","occurred_at":"2026-05-01T10:00:00.000Z",)"
                       R"("data":{"id":"sub_1","status":")" + verb + R"("}})")
                 ->getStatusCode(),
             drogon::k200OK);

  REQUIRE(h.subscriptions.subscriptions.size() == 9u);
  CHECK_EQ(h.subscriptions.subscriptions[0].status, std::string("created"));
  CHECK_EQ(h.subscriptions.subscriptions[8].status, std::string("imported"));
}

TEST(billing_the_read_needs_a_signed_in_caller) {
  Harness h;
  CHECK_EQ(read(h, "")->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ((*read(h, "")->getJsonObject())["error"].asString(), std::string("sign in first"));
}

// Every account before its first checkout. "none" is a status the UI can render; an absent key or a
// 404 would each make the caller guess.
TEST(billing_an_account_with_no_paddle_customer_reads_as_none_and_inactive) {
  Harness h;
  h.signIn("s-live");

  const Json::Value body = *read(h, "s-live")->getJsonObject();
  CHECK_EQ(body["status"].asString(), std::string("none"));
  CHECK_FALSE(body["active"].asBool());
  CHECK_FALSE(body.isMember("subscriptionId"));
  CHECK_FALSE(body.isMember("scheduledChangeAt"));
}

// The read reports Paddle's own vocabulary verbatim AND our verdict on it, separately — a client
// that only saw a boolean could not say "cancels on the 12th", and one that only saw the word would
// have to re-implement the access rule.
TEST(billing_the_read_reports_paddle_s_word_and_our_verdict_on_it_separately) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscriptions.push_back(PaddleSubscription{
      "sub_1", "ctm_1", user.str(), "active", "pri_1", "pro_1", "2026-06-01T00:00:00Z", ""});

  const Json::Value body = *read(h, "s-live")->getJsonObject();
  CHECK_EQ(body["status"].asString(), std::string("active"));
  CHECK(body["active"].asBool());
  CHECK_EQ(body["subscriptionId"].asString(), std::string("sub_1"));
  CHECK_EQ(body["priceId"].asString(), std::string("pri_1"));
  CHECK_EQ(body["productId"].asString(), std::string("pro_1"));
  CHECK_EQ(body["scheduledChangeAt"].asString(), std::string("2026-06-01T00:00:00Z"));

  // Nothing pending: the key is absent rather than empty, so the UI tests it once.
  h.subscriptions.subscriptions[0].scheduledChangeAt.clear();
  h.subscriptions.subscriptions[0].status = "canceled";
  const Json::Value ended = *read(h, "s-live")->getJsonObject();
  CHECK_EQ(ended["status"].asString(), std::string("canceled"));
  CHECK_FALSE(ended["active"].asBool());
  CHECK_FALSE(ended.isMember("scheduledChangeAt"));
}

// The checkout opens from the session alone — there is no field to mistype and no way to open one
// for anyone else — and a deployment with no Paddle credentials says so plainly rather than 500ing.
TEST(billing_a_checkout_needs_a_signed_in_caller_and_a_configured_paddle) {
  Harness h;

  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/v1/billing/checkout");
  drogon::HttpResponsePtr captured;
  h.api.startCheckout(req, [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(captured->getStatusCode(), drogon::k401Unauthorized);

  h.signIn("s-live");
  req->addCookie("wm_session", "s-live");
  h.api.startCheckout(req, [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(captured->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ((*captured->getJsonObject())["error"].asString(),
           std::string("billing is not configured"));
}
