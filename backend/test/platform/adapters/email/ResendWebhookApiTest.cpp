#include "platform/adapters/email/ResendWebhookApi.h"

#include "test/application/AuthFakes.h"
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

// One product's answer to a dead mailbox, as a script. Deliberately NOT roadmap's or journal's own
// fake: this receiver is platform's, it knows no product, and a test that reached for a product's
// repository to drive it would quietly assert the opposite. `dead` makes the write throw, which is
// the only way a stream can fail.
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

// The signature the sender would have produced. Signing here rather than pasting a fixed digest per
// body is safe precisely because the SCHEME is pinned elsewhere, against a vector computed outside
// this codebase (adapters/email/ResendSignatureTest.cpp) — this file is about what the handler does
// with an event it has already accepted.
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

// A body nested past jsoncpp's 1000-frame stackLimit. The reader does not answer "too deep" — it
// THROWS Json::RuntimeError — so a handler that only asks whether the parse produced an object never
// gets to ask: the exception walks straight out of it and takes the process with it.
std::string deeplyNested(int depth) {
  return std::string(depth, '[') + std::string(depth, ']');
}

// The same bomb where it would actually arrive: buried in a real-shaped bounce, under a key we
// never read. Nothing about the event is surprising until the parser reaches the tag.
std::string deeplyNestedTag(int depth) {
  return std::string(R"({"type":"email.bounced","data":{"to":["sam@example.com"],)"
                     R"("bounce":{"type":"Permanent"},"tags":)") +
         deeplyNested(depth) + "}}";
}

// Two products behind one mail account, which is the shape of the real deployment: main.cpp
// registers one stream per product that mails, and gym registers none.
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
  // The whole reason this receiver is platform's. One Resend account, one webhook, and a mailbox
  // that is gone is gone for everybody — a receiver that stopped only the product it lived in would
  // leave every other one writing to an address the provider has already called dead.
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
  // The defect every naive implementation ships: a full or throttled mailbox silences someone for
  // good, and nothing ever tells them why. A transient bounce is a 200 that changes nothing.
  Harness h;

  CHECK_EQ(post(h, signedDelivery(bouncedBody("sam@example.com", "Transient")))->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(bouncedBody("sam@example.com", "Undetermined")))->getStatusCode(),
           drogon::k200OK);

  CHECK(h.roadmap->stopped.empty());
  CHECK(h.journal->stopped.empty());
}

TEST(resend_webhook_a_deployment_whose_products_send_no_mail_verifies_and_does_nothing) {
  // Gym registers no stream, and a gym-only deployment registers none at all. An empty list is a
  // configuration this endpoint must survive, not a case it may fall over on.
  auto clock = std::make_shared<FakeClock>();
  ResendWebhookApi bare(std::vector<MailStream>{}, clock, kSecret);

  drogon::HttpResponsePtr captured;
  bare.webhook(signedDelivery(bouncedBody("sam@example.com", "Permanent")),
               [&](const drogon::HttpResponsePtr& response) { captured = response; });

  CHECK_EQ(captured->getStatusCode(), drogon::k200OK);
  CHECK((*captured->getJsonObject())["received"].asBool());
}

TEST(resend_webhook_an_unknown_event_type_is_a_200_noop) {
  // Never a 500 for a shape we merely do not recognise: Resend would redeliver it until its retry
  // budget was gone, and the event we cannot read still tells us nothing.
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
  // A 404 here would make this door an account-existence oracle for anyone who can reach it, and
  // this codebase already treats existence oracles as defects.
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
  // A genuine delivery captured off the wire and re-sent an hour later. Both the id and the
  // timestamp are inside the signed payload, so it cannot be refreshed into the window either.
  Harness h;
  const std::string body = bouncedBody("sam@example.com", "Permanent");
  const drogon::HttpRequestPtr captured = signedDelivery(body);

  h.clock->now += 60ull * 60 * 1000;

  CHECK_EQ(post(h, captured)->getStatusCode(), drogon::k401Unauthorized);
  CHECK(h.roadmap->stopped.empty());
  // Re-labelling it with a fresh timestamp does not help: the old digest no longer covers it.
  const std::string fresh = "1700003600";
  CHECK_EQ(post(h, delivery(body, sign(body, kMessageId, kTimestamp), kMessageId, fresh))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK(h.roadmap->stopped.empty());
  // ...whereas a delivery actually signed at that moment is accepted.
  CHECK_EQ(post(h, delivery(body, sign(body, kMessageId, fresh), kMessageId, fresh))->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(h.roadmap->stopped, kOnce);
  CHECK_EQ(h.journal->stopped, kOnce);
}

TEST(resend_webhook_an_unconfigured_secret_refuses_every_delivery) {
  // An unarmed verifier that accepted everything would be strictly worse than no endpoint: anyone
  // could tell us that anyone's address bounced.
  Harness dark("");

  CHECK_EQ(post(dark, signedDelivery(bouncedBody("sam@example.com", "Permanent")))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK(dark.roadmap->stopped.empty());
  CHECK(dark.journal->stopped.empty());
}

TEST(resend_webhook_a_secret_wrapped_in_env_file_noise_still_verifies) {
  // Measured, and nasty because it is silent: a trailing newline survives the lenient base64
  // decoder, but a LEADING space or a quoted value pushes `whsec_` off the front, those six
  // characters become key material, and the endpoint goes dark with no other symptom anywhere.
  for (const std::string& shape : {" " + kSecret, kSecret + "\n", kSecret + "\r\n",
                                   "'" + kSecret + "'", "\"" + kSecret + "\""}) {
    Harness h(shape);
    CHECK_EQ(post(h, signedDelivery(bouncedBody("sam@example.com", "Permanent")))->getStatusCode(),
             drogon::k200OK);
    CHECK_EQ(h.roadmap->stopped, kOnce);
    CHECK_EQ(h.journal->stopped, kOnce);
  }
  // ...and noise alone is still no secret at all.
  Harness blank("  \n");
  CHECK_EQ(post(blank, signedDelivery(bouncedBody("sam@example.com", "Permanent")))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK(blank.roadmap->stopped.empty());
}

TEST(resend_webhook_a_verified_body_of_a_surprising_shape_never_throws) {
  // Only Resend can reach past the signature, but a payload we do not own must still degrade to a
  // decision rather than to an exception: jsoncpp throws on a lookup into a non-object AND on a body
  // nested past its stackLimit, and a throw here kills the process, not merely the request.
  Harness h;

  CHECK_EQ(post(h, signedDelivery("not json at all"))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, signedDelivery("[1,2,3]"))->getStatusCode(), drogon::k400BadRequest);
  // One frame under jsoncpp's limit is an ordinary 400; one frame over is reported by THROWING, and
  // must be the same 400 rather than an exception walking out of the handler.
  CHECK_EQ(post(h, signedDelivery(deeplyNested(999)))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, signedDelivery(deeplyNested(1001)))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, signedDelivery(deeplyNested(20000)))->getStatusCode(), drogon::k400BadRequest);
  // And the same bomb hidden inside a real-shaped bounce, under a key this handler never reads: the
  // PARSE is what fails, so an event we would otherwise act on is refused whole rather than acted on.
  CHECK_EQ(post(h, signedDelivery(deeplyNestedTag(1001)))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(post(h, signedDelivery(deeplyNestedTag(20000)))->getStatusCode(), drogon::k400BadRequest);

  CHECK_EQ(post(h, signedDelivery("{}"))->getStatusCode(), drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(R"({"type":"email.bounced","data":"oops"})"))->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(R"({"type":"email.bounced","data":{"to":"sam@example.com","bounce":7}})"))
               ->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(post(h, signedDelivery(R"({"type":42,"data":{"to":[7]}})"))->getStatusCode(), drogon::k200OK);
  // A recipient that isn't an address resolves to nobody, and nobody is a no-op.
  CHECK_EQ(post(h, signedDelivery(R"({"type":"email.complained","data":{"to":["not-an-address"]}})"))
               ->getStatusCode(),
           drogon::k200OK);
  CHECK(h.roadmap->stopped.empty());
  CHECK(h.journal->stopped.empty());

  // A bare string recipient is a shape we do not produce but would still act on correctly.
  CHECK_EQ(post(h, signedDelivery(
                       R"({"type":"email.bounced","data":{"to":"sam@example.com","bounce":{"type":"Permanent"}}})"))
               ->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(h.roadmap->stopped, kOnce);
  CHECK_EQ(h.journal->stopped, kOnce);
}

TEST(resend_webhook_a_redelivery_is_idempotent_with_no_dedup_table) {
  // Setting a boolean that is already true is the same write twice, which is the whole of why a
  // retried webhook needs no seen-ids table to be harmless. The fakes record every call, so this
  // asserts the write REPEATED rather than that it was skipped — idempotence in the row, never a
  // dedup in the handler.
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
  // Two writes, two transactions, two tables: all-or-nothing is not on offer inside one delivery.
  // What IS on offer is best-effort ACROSS the streams and all-or-nothing OVER TIME — a roadmap
  // outage must not leave journal mailing a mailbox we know is gone, and the 500 afterwards asks
  // Svix to redeliver the whole event until every stream has it.
  Harness h;
  h.roadmap->dead = true;

  const drogon::HttpResponsePtr response =
      post(h, signedDelivery(bouncedBody("sam@example.com", "Permanent")));

  CHECK_EQ(response->getStatusCode(), drogon::k500InternalServerError);
  CHECK_EQ((*response->getJsonObject())["error"].asString(),
           std::string("not recorded: roadmap reminder"));
  CHECK(h.roadmap->stopped.empty());
  CHECK_EQ(h.journal->stopped, kOnce);  // attempted anyway, and it landed

  // The redelivery once the table is back: the write that already landed is repeated harmlessly and
  // the missing one lands, which is the whole of why "500 and retry" is enough here.
  h.roadmap->dead = false;
  CHECK_EQ(post(h, signedDelivery(bouncedBody("sam@example.com", "Permanent")))->getStatusCode(),
           drogon::k200OK);
  CHECK_EQ(h.roadmap->stopped, kOnce);
  CHECK_EQ(h.journal->stopped, (std::vector<std::string>{"sam@example.com", "sam@example.com"}));
}

TEST(resend_webhook_every_failing_stream_is_named_in_the_one_500) {
  // An operator reading a failed delivery needs to know WHICH product still thinks that mailbox is
  // alive; a 500 naming none of them would send them through three products' logs in turn.
  Harness h;
  h.roadmap->dead = true;
  h.journal->dead = true;

  const drogon::HttpResponsePtr response = post(h, signedDelivery(complainedBody("sam@example.com")));

  CHECK_EQ(response->getStatusCode(), drogon::k500InternalServerError);
  CHECK_EQ((*response->getJsonObject())["error"].asString(),
           std::string("not recorded: roadmap reminder, journal nudge"));
}
