#include "platform/adapters/email/ResendWebhookApi.h"

#include "platform/adapters/email/ResendSignature.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/domain/Mail.h"

#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <exception>
#include <optional>
#include <utility>

namespace wm {

namespace {
// How many refusals in an unbroken run before one is raised from debug to a warning an operator can
// find. Low enough that a wrong secret surfaces within the first minutes of Svix's retries, high
// enough that a scanner walking the API never trips it.
constexpr unsigned kRefusalsBeforeAlarm = 10;

// asString() throws on a non-string node; read every field defensively so a surprising payload
// degrades to empty rather than throwing inside the handler.
std::string asStr(const Json::Value& value) {
  return value.isString() ? value.asString() : std::string();
}

// Resend names the recipient in data.to. Every mail Windmill sends goes to exactly one address —
// ResendClient::send takes one Email, already lowercased by parseEmail on the way in — so an event
// about several is not a thing we can produce, and the first entry is the whole answer. Matching it
// exactly is likewise enough: users.email is citext, so however the provider cased the address back
// to us, it resolves to the same row. A bare string is accepted beside the array because a shape we
// do not own is not a shape to be brittle about.
std::string recipientOf(const Json::Value& data) {
  const Json::Value& to = data["to"];
  if (to.isString()) return to.asString();
  if (to.isArray() && !to.empty()) return asStr(to[0]);
  return "";
}

// Resend's own acknowledgement shape, matching the Paddle webhook's: a delivery is settled the
// moment we answer 2xx, so this body is the whole of what "we have it" means.
drogon::HttpResponsePtr received() {
  Json::Value body(Json::objectValue);
  body["received"] = true;
  return jsonResponse(body);
}
}

ResendWebhookApi::ResendWebhookApi(std::vector<MailStream> streams, std::shared_ptr<Clock> clock,
                                   std::string signingSecret)
    : streams_(std::move(streams)), clock_(std::move(clock)),
      signingSecret_(std::move(signingSecret)) {}

void ResendWebhookApi::webhook(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // The signature covers the exact bytes Resend sent, so verify against the raw body — a
  // reserialization of parsed JSON is a different string and would never match. This runs FIRST,
  // before a single field is read, so an unsigned caller can never make this endpoint do work.
  const std::string body{req->getBody()};
  if (signingSecret_.empty() ||
      !verifyResendSignature(body, req->getHeader("svix-id"), req->getHeader("svix-timestamp"),
                             req->getHeader("svix-signature"), signingSecret_, clock_->nowMs())) {
    // A refused delivery is ordinary traffic on a public, unauthenticated door, and installLogTee
    // ships everything at SENTRY_LOG_LEVEL (default info) and above — so logging each one as an
    // error pages an operator for every internet scanner. What IS worth surfacing is a RUN of them
    // with nothing accepted in between: register the endpoint before the secret is deployed and
    // every genuine bounce lands here, refused and retried, with no other symptom anywhere.
    const unsigned refused = ++refusalsInARow_;
    if (refused % kRefusalsBeforeAlarm == 0)
      LOG_WARN << "resend webhook: " << refused
               << " deliveries in a row refused — is RESEND_WEBHOOK_SECRET set to THIS endpoint's "
                  "signing secret?";
    else
      LOG_DEBUG << "resend webhook: refused a delivery that did not verify";
    callback(error(drogon::k401Unauthorized, "signature did not verify"));
    return;
  }
  refusalsInARow_ = 0;

  // A verified body is Resend's, and still not a body we own. jsoncpp reports a payload nested past
  // its stackLimit by THROWING rather than by failing, and an exception out of a handler is a 5xx
  // Resend would redeliver forever — so everything we cannot read, at any depth, is this one 400.
  std::shared_ptr<Json::Value> json;
  try {
    json = req->getJsonObject();
  } catch (const std::exception& e) {
    LOG_DEBUG << "resend webhook: verified body would not parse: " << e.what();
    json.reset();
  }
  if (!json || !json->isObject()) {
    callback(error(drogon::k400BadRequest, "not a JSON event"));
    return;
  }

  // Past the parse, jsoncpp still throws on a lookup into a value that is not an object, so each
  // level is stepped into only once it is known to BE one. A payload that surprises us reads as an
  // event with no severity and no recipient, which the rule below already treats as no evidence.
  const Json::Value& event = *json;
  const Json::Value& data = event["data"].isObject() ? event["data"] : Json::Value::nullSingleton();
  const Json::Value& bounce = data["bounce"].isObject() ? data["bounce"] : Json::Value::nullSingleton();
  const std::optional<Email> recipient = parseEmail(recipientOf(data));
  const MailFeedback feedback{asStr(event["type"]), asStr(bounce["type"]),
                              recipient.value_or(Email{})};

  // The whole decision, made where it belongs. A soft bounce, a delivery receipt, an open, an event
  // type that does not exist yet, and a recipient that is not an address at all: every one of them
  // falls through to the same acknowledgement, which is what makes 200 the shape of this handler
  // rather than a case inside it.
  if (verdictOn(feedback) != MailVerdict::stopMailing || !recipient) {
    callback(received());
    return;
  }

  // One dead mailbox, every stream that writes to it. Best-effort ACROSS the streams and
  // all-or-nothing OVER TIME: a stream that throws never short-circuits the rest, because a roadmap
  // outage must not leave journal mailing an address the provider has already called dead — and the
  // 500 afterwards asks Svix to redeliver the whole event. Every write is idempotent, so the
  // redelivery re-applies what already landed for free and retries only what is still missing.
  std::string unwritten;
  for (const MailStream& stream : streams_) {
    try {
      if (stream.suppression->stopMailing(*recipient))
        LOG_INFO << "resend webhook: " << stream.name << " stopped after " << feedback.eventType;
    } catch (const std::exception& e) {
      LOG_ERROR << "resend webhook: " << stream.name << " not stopped: " << e.what();
      unwritten = unwritten.empty() ? stream.name : unwritten + ", " + stream.name;
    }
  }
  if (!unwritten.empty()) {
    callback(error(drogon::k500InternalServerError, "not recorded: " + unwritten));
    return;
  }
  callback(received());
}

}
