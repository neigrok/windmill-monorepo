#include "platform/adapters/email/ResendWebhookApi.h"

#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <drogon/utils/Utilities.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>

#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

const std::string kSecret = "whsec_d2luZG1pbGwtcmVzZW5kLXRlc3Qtc2VjcmV0LWtleSE=";
const std::string kMessageId = "msg_2gTQ4hK1nZpV9wXcLm3Rd7Yb";
const std::string kTimestamp = "1700000000";  // the FakeClock's own second

// One product's answer to a dead mailbox, as a script. `dead` makes the write throw, which is the only way a stream can fail.
struct FakeStream : MailSuppression {
  std::set<std::string> known;              // addresses a live account owns
  std::vector<std::string> stopped;         // every call that found one, in order
  bool dead = false;

  bool stopMailing(const Email& address) override {
    if (dead) throw std::runtime_error("that table is on fire");
    if (known.count(address.value) == 0) return false;
    stopped.push_back(address.value);
    return true;
  }
};

// The signature the sender would have produced; the SCHEME itself is pinned in adapters/email/ResendSignatureTest.cpp.
std::string sign(const std::string& body, const std::string& messageId,
                 const std::string& timestamp) {
  const std::string key = drogon::utils::base64Decode(kSecret.substr(6));
  const std::string payload = messageId + "." + timestamp + "." + body;
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int macLength = 0;
  HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()),
       reinterpret_cast<const unsigned char*>(payload.data()), payload.size(), mac, &macLength);
  return "v1," + drogon::utils::base64Encode(mac, macLength);
}

std::string bouncedBody(const char* address, const char* bounceType) {
  return std::string(R"({"type":"email.bounced","created_at":"2026-08-02T09:00:00.000Z","data":{)") +
         R"("email_id":"e_1","from":"Windmill <hi@windmill.works>","to":[")" + address +
         R"("],"subject":"Your tree has steps ready","bounce":{"message":"host said no","subType":"General","type":")" +
         bounceType + R"("}}})";
}

std::string complainedBody(const char* address) {
  return std::string(R"({"type":"email.complained","created_at":"2026-08-02T09:00:00.000Z","data":{)") +
         R"("email_id":"e_1","to":[")" + address + R"("],"subject":"Your tree has steps ready"}})";
}

// A body nested past jsoncpp's 1000-frame stackLimit: the reader THROWS Json::RuntimeError rather than answering "too deep".
std::string deeplyNested(int depth) {
  return std::string(depth, '[') + std::string(depth, ']');
}

// The same bomb buried in a real-shaped bounce, under a key the handler never reads.
std::string deeplyNestedTag(int depth) {
  return std::string(R"({"type":"email.bounced","data":{"to":["sam@example.com"],)"
                     R"("bounce":{"type":"Permanent"},"tags":)") +
         deeplyNested(depth) + "}}";
}

// Two products behind one mail account: main.cpp registers one stream per product that mails, and gym registers none.
struct Harness {
  std::shared_ptr<FakeStream> roadmap = std::make_shared<FakeStream>();
  std::shared_ptr<FakeStream> journal = std::make_shared<FakeStream>();
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  std::shared_ptr<ResendWebhookApi> api;

  explicit Harness(std::string secret = kSecret)
      : api(std::make_shared<ResendWebhookApi>(
            std::vector<MailStream>{{"roadmap reminder", roadmap}, {"journal nudge", journal}},
            clock, std::move(secret))) {
    roadmap->known.insert("sam@example.com");
    journal->known.insert("sam@example.com");
  }
};

const std::vector<std::string> kOnce{"sam@example.com"};

drogon::HttpRequestPtr delivery(const std::string& body, const std::string& signature,
                                const std::string& messageId = kMessageId,
                                const std::string& timestamp = kTimestamp) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/v1/resend/webhook");
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(body);
  req->addHeader("svix-id", messageId);
  req->addHeader("svix-timestamp", timestamp);
  req->addHeader("svix-signature", signature);
  return req;
}

drogon::HttpRequestPtr signedDelivery(const std::string& body) {
  return delivery(body, sign(body, kMessageId, kTimestamp));
}

drogon::HttpResponsePtr post(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->webhook(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

}

TEST(resend_webhook_one_hard_bounce_stops_every_product_s_mail_to_that_mailbox) {
  Harness h;

  const drogon::HttpResponsePtr response =
      post(h, signedDelivery(bouncedBody("sam@example.com", "Permanent")));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK((*response->getJsonObject())["received"].asBool());
  CHECK_EQ(h.roadmap->stopped, kOnce);
  CHECK_EQ(h.journal->stopped, kOnce);
}

TEST(resend_webhook_a_spam_complaint_stops_every_product_too) {
  Harness h;

  CHECK_EQ(post(h, signedDelivery(complainedBody("sam@example.com")))->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(h.roadmap->stopped, kOnce);
  CHECK_EQ(h.journal->stopped, kOnce);
}

TEST(resend_webhook_a_soft_bounce_stops_nobody) {
  Harness h;

  CHECK_EQ(post(h, signedDelivery(bouncedBody("sam@example.com", "Transient")))->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(bouncedBody("sam@example.com", "Undetermined")))->getStatusCode(),
           drogon::k200OK);

  CHECK(h.roadmap->stopped.empty());
  CHECK(h.journal->stopped.empty());
}

TEST(resend_webhook_a_deployment_whose_products_send_no_mail_verifies_and_does_nothing) {
  auto clock = std::make_shared<FakeClock>();
  ResendWebhookApi bare(std::vector<MailStream>{}, clock, kSecret);

  drogon::HttpResponsePtr captured;
  bare.webhook(signedDelivery(bouncedBody("sam@example.com", "Permanent")),
               [&](const drogon::HttpResponsePtr& response) { captured = response; });

  CHECK_EQ(captured->getStatusCode(), drogon::k200OK);
  CHECK((*captured->getJsonObject())["received"].asBool());
}

TEST(resend_webhook_an_unknown_event_type_is_a_200_noop) {
  Harness h;

  const std::string delivered = R"({"type":"email.delivered","data":{"to":["sam@example.com"]}})";
  CHECK_EQ(post(h, signedDelivery(delivered))->getStatusCode(), drogon::k200OK);

  const std::string invented =
      R"({"type":"email.quarantined","data":{"to":["sam@example.com"],"bounce":{"type":"Permanent"}}})";
  CHECK_EQ(post(h, signedDelivery(invented))->getStatusCode(), drogon::k200OK);

  CHECK(h.roadmap->stopped.empty());
  CHECK(h.journal->stopped.empty());
}

TEST(resend_webhook_an_address_no_account_owns_is_a_200_noop) {
  Harness h;

  const drogon::HttpResponsePtr response =
      post(h, signedDelivery(bouncedBody("stranger@example.com", "Permanent")));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK((*response->getJsonObject())["received"].asBool());
  CHECK(h.roadmap->stopped.empty());
  CHECK(h.journal->stopped.empty());
}

TEST(resend_webhook_a_bad_signature_is_a_401_and_reads_nothing) {
  Harness h;
  const std::string body = bouncedBody("sam@example.com", "Permanent");

  // A forged digest.
  CHECK_EQ(post(h, delivery(body, "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="))->getStatusCode(),
           drogon::k401Unauthorized);
  // The right digest over a body that was then edited — the signature covers the exact bytes.
  const std::string signature = sign(body, kMessageId, kTimestamp);
  CHECK_EQ(post(h, delivery(bouncedBody("mallory@example.com", "Permanent"), signature))->getStatusCode(),
           drogon::k401Unauthorized);
  // The right digest replayed under a different message id.
  CHECK_EQ(post(h, delivery(body, signature, "msg_someone_elses"))->getStatusCode(),
           drogon::k401Unauthorized);
  // And no headers at all.
  CHECK_EQ(post(h, delivery(body, ""))->getStatusCode(), drogon::k401Unauthorized);

  CHECK(h.roadmap->stopped.empty());
  CHECK(h.journal->stopped.empty());
}

TEST(resend_webhook_a_replayed_delivery_is_a_401) {
  Harness h;
  const std::string body = bouncedBody("sam@example.com", "Permanent");
  const drogon::HttpRequestPtr captured = signedDelivery(body);

  h.clock->now += 60ull * 60 * 1000;

  CHECK_EQ(post(h, captured)->getStatusCode(), drogon::k401Unauthorized);
  CHECK(h.roadmap->stopped.empty());
  const std::string fresh = "1700003600";
  CHECK_EQ(post(h, delivery(body, sign(body, kMessageId, kTimestamp), kMessageId, fresh))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK(h.roadmap->stopped.empty());
  CHECK_EQ(post(h, delivery(body, sign(body, kMessageId, fresh), kMessageId, fresh))->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(h.roadmap->stopped, kOnce);
  CHECK_EQ(h.journal->stopped, kOnce);
}

TEST(resend_webhook_an_unconfigured_secret_refuses_every_delivery) {
  Harness dark("");

  CHECK_EQ(post(dark, signedDelivery(bouncedBody("sam@example.com", "Permanent")))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK(dark.roadmap->stopped.empty());
  CHECK(dark.journal->stopped.empty());
}

TEST(resend_webhook_a_secret_wrapped_in_env_file_noise_still_verifies) {
  // A trailing newline survives the lenient base64 decoder, but a leading space or a quoted value pushes `whsec_` off the front and those six characters become key material.
  for (const std::string& shape : {" " + kSecret, kSecret + "\n", kSecret + "\r\n",
                                   "'" + kSecret + "'", "\"" + kSecret + "\""}) {
    Harness h(shape);
    CHECK_EQ(post(h, signedDelivery(bouncedBody("sam@example.com", "Permanent")))->getStatusCode(),
             drogon::k200OK);
    CHECK_EQ(h.roadmap->stopped, kOnce);
    CHECK_EQ(h.journal->stopped, kOnce);
  }
  Harness blank("  \n");
  CHECK_EQ(post(blank, signedDelivery(bouncedBody("sam@example.com", "Permanent")))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK(blank.roadmap->stopped.empty());
}

TEST(resend_webhook_a_verified_body_of_a_surprising_shape_never_throws) {
  // jsoncpp throws on a lookup into a non-object AND on a body nested past its stackLimit, and a throw here kills the process, not merely the request.
  Harness h;

  CHECK_EQ(post(h, signedDelivery("not json at all"))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, signedDelivery("[1,2,3]"))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, signedDelivery(deeplyNested(999)))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, signedDelivery(deeplyNested(1001)))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, signedDelivery(deeplyNested(20000)))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, signedDelivery(deeplyNestedTag(1001)))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, signedDelivery(deeplyNestedTag(20000)))->getStatusCode(), drogon::k400BadRequest);

  CHECK_EQ(post(h, signedDelivery("{}"))->getStatusCode(), drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(R"({"type":"email.bounced","data":"oops"})"))->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(R"({"type":"email.bounced","data":{"to":"sam@example.com","bounce":7}})"))
               ->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(R"({"type":42,"data":{"to":[7]}})"))->getStatusCode(), drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(R"({"type":"email.complained","data":{"to":["not-an-address"]}})"))
               ->getStatusCode(),
           drogon::k200OK);
  CHECK(h.roadmap->stopped.empty());
  CHECK(h.journal->stopped.empty());

  CHECK_EQ(post(h, signedDelivery(
                       R"({"type":"email.bounced","data":{"to":"sam@example.com","bounce":{"type":"Permanent"}}})"))
               ->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(h.roadmap->stopped, kOnce);
  CHECK_EQ(h.journal->stopped, kOnce);
}

TEST(resend_webhook_a_redelivery_is_idempotent_with_no_dedup_table) {
  // Setting a boolean that is already true is the same write twice: idempotence lives in the row, never in a dedup in the handler.
  Harness h;
  const std::string body = bouncedBody("sam@example.com", "Permanent");

  CHECK_EQ(post(h, signedDelivery(body))->getStatusCode(), drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(body))->getStatusCode(), drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(body))->getStatusCode(), drogon::k200OK);

  const std::vector<std::string> thrice{"sam@example.com", "sam@example.com", "sam@example.com"};
  CHECK_EQ(h.roadmap->stopped, thrice);
  CHECK_EQ(h.journal->stopped, thrice);
}

TEST(resend_webhook_a_stream_that_throws_never_swallows_the_others_then_asks_for_a_retry) {
  // Two writes, two transactions, two tables: best-effort ACROSS the streams, all-or-nothing OVER TIME — the 500 asks Svix to redeliver until every stream has it.
  Harness h;
  h.roadmap->dead = true;

  const drogon::HttpResponsePtr response =
      post(h, signedDelivery(bouncedBody("sam@example.com", "Permanent")));

  CHECK_EQ(response->getStatusCode(), drogon::k500InternalServerError);
  CHECK_EQ((*response->getJsonObject())["error"].asString(),
           std::string("not recorded: roadmap reminder"));
  CHECK(h.roadmap->stopped.empty());
  CHECK_EQ(h.journal->stopped, kOnce);

  h.roadmap->dead = false;
  CHECK_EQ(post(h, signedDelivery(bouncedBody("sam@example.com", "Permanent")))->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(h.roadmap->stopped, kOnce);
  CHECK_EQ(h.journal->stopped, (std::vector<std::string>{"sam@example.com", "sam@example.com"}));
}

TEST(resend_webhook_every_failing_stream_is_named_in_the_one_500) {
  Harness h;
  h.roadmap->dead = true;
  h.journal->dead = true;

  const drogon::HttpResponsePtr response = post(h, signedDelivery(complainedBody("sam@example.com")));

  CHECK_EQ(response->getStatusCode(), drogon::k500InternalServerError);
  CHECK_EQ((*response->getJsonObject())["error"].asString(),
           std::string("not recorded: roadmap reminder, journal nudge"));
}
