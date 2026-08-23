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
// How many refusals in an unbroken run before one is raised from debug to a warning.
constexpr unsigned kRefusalsBeforeAlarm = 10;

// asString() throws on a non-string node; read every field defensively.
std::string asStr(const Json::Value& value) {
  return value.isString() ? value.asString() : std::string();
}

// Resend names the recipient in data.to — one address per mail, as an array or a bare string.
std::string recipientOf(const Json::Value& data) {
  const Json::Value& to = data["to"];
  if (to.isString()) return to.asString();
  if (to.isArray() && !to.empty()) return asStr(to[0]);
  return "";
}

// Resend's acknowledgement shape: a delivery is settled the moment we answer 2xx.
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
  // reserialization of parsed JSON would never match. Runs FIRST, before a single field is read.
  const std::string body{req->getBody()};
  if (signingSecret_.empty() ||
      !verifyResendSignature(body, req->getHeader("svix-id"), req->getHeader("svix-timestamp"),
                             req->getHeader("svix-signature"), signingSecret_, clock_->nowMs())) {
    // Refusals are ordinary traffic on a public door; only an unbroken RUN of them, with nothing
    // accepted in between, is worth surfacing.
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

  // jsoncpp reports a payload nested past its stackLimit by THROWING rather than by failing, and an
  // exception out of a handler is a 5xx Resend would redeliver forever.
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
  // level is stepped into only once it is known to BE one.
  const Json::Value& event = *json;
  const Json::Value& data = event["data"].isObject() ? event["data"] : Json::Value::nullSingleton();
  const Json::Value& bounce = data["bounce"].isObject() ? data["bounce"] : Json::Value::nullSingleton();
  const std::optional<Email> recipient = parseEmail(recipientOf(data));
  const MailFeedback feedback{asStr(event["type"]), asStr(bounce["type"]),
                              recipient.value_or(Email{})};

  // Everything that is not a stop-mailing verdict falls through to the same 200.
  if (verdictOn(feedback) != MailVerdict::stopMailing || !recipient) {
    callback(received());
    return;
  }

  // Best-effort ACROSS the streams and all-or-nothing OVER TIME: a stream that throws never
  // short-circuits the rest, and the 500 afterwards asks Svix to redeliver the whole event.
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
