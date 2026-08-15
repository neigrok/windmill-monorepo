#include "products/roadmap/adapters/http/RemindersApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>

namespace wm {

namespace {
// An IANA name is short by construction ("America/Argentina/Buenos_Aires" is 30); anything
// longer is not a timezone, and refusing it here keeps junk out of the column and off the probe.
constexpr std::size_t kMaxTimezoneBytes = 64;

drogon::HttpResponsePtr noContent() {
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  return response;
}

// `armed` is whether the engine can reach THIS CALLER — the feature flag AND their place on the
// allowlist — while `enabled` is what they asked for. Answering the caller's question with the
// feature's would advertise the switch to the whole fleet during a rollout whose entire point is
// that one account is reachable: every stranger would turn it on, be told when we send, and get
// nothing for a month by design. The section renders nothing while the engine cannot reach you,
// which is how the tending meter already behaves; a 404 would have been a small lie told to a
// signed-in caller whose settings do exist.
Json::Value toJson(const ReminderSettings& settings, bool armed) {
  Json::Value body(Json::objectValue);
  body["armed"] = armed;
  body["enabled"] = settings.enabled;
  body["timezone"] = settings.timezone;
  body["slotDow"] = settings.slotDow;
  body["slotMinute"] = settings.slotMinute;
  body["suppressed"] = settings.suppressed;
  return body;
}

Json::Value toJson(const MailSweepReport& report) {
  Json::Value body(Json::objectValue);
  body["ran"] = report.ran;
  body["due"] = report.due;
  body["claimed"] = report.claimed;
  body["sent"] = report.sent;
  body["failed"] = report.failed;
  body["held"] = report.held;
  body["wouldSend"] = report.wouldSend;
  body["skipped"] = report.skipped;
  body["errors"] = report.errors;
  return body;
}

std::string bearerOf(const drogon::HttpRequestPtr& req) {
  const std::string authorization = req->getHeader("authorization");
  if (authorization.rfind("Bearer ", 0) != 0) return "";
  return authorization.substr(7);
}
}

RemindersApi::RemindersApi(std::shared_ptr<ReminderSweep> sweep,
                           std::shared_ptr<ReminderRepository> reminders,
                           std::shared_ptr<AuthService> auth, std::shared_ptr<TokenGenerator> tokens,
                           std::shared_ptr<Clock> clock, std::string adminToken)
    : sweep_(std::move(sweep)), reminders_(std::move(reminders)), auth_(std::move(auth)),
      tokens_(std::move(tokens)), clock_(std::move(clock)), adminToken_(std::move(adminToken)) {}

void RemindersApi::getSettings(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to read your reminders"));
    return;
  }
  // No row yet is not an error: it is the honest "off, and we don't know where you are", which is
  // exactly what the defaults say.
  callback(jsonResponse(toJson(reminders_->settingsFor(*caller).value_or(ReminderSettings{}),
                               sweep_->arming().allows(*caller))));
}

void RemindersApi::patchSettings(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to change your reminders"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    callback(error(drogon::k400BadRequest, "send {enabled} and/or {timezone}"));
    return;
  }

  // A patch edits what is there: an absent field means "leave it alone", so turning reminders on
  // and moving timezone are independent acts that can also arrive together. A field that IS there
  // must be the type it claims: jsoncpp throws on a conversion it cannot make, and an exception
  // escaping this handler would be an anonymous 500 plus a Sentry event per request.
  ReminderSettings settings = reminders_->settingsFor(*caller).value_or(ReminderSettings{});
  if (json->isMember("enabled")) {
    if (!(*json)["enabled"].isBool()) {
      callback(error(drogon::k400BadRequest, "enabled must be true or false"));
      return;
    }
    settings.enabled = (*json)["enabled"].asBool();
  }
  if (json->isMember("timezone")) {
    if (!(*json)["timezone"].isString()) {
      callback(error(drogon::k400BadRequest, "that doesn't look like a timezone"));
      return;
    }
    settings.timezone = (*json)["timezone"].asString();
  }

  if (settings.timezone.size() > kMaxTimezoneBytes) {
    callback(error(drogon::k400BadRequest, "that doesn't look like a timezone"));
    return;
  }
  // Without a zone there is no hour to send at, and defaulting to UTC would mail US users at 4am.
  // So enabling without one is refused rather than silently accepted into permanent silence.
  if (settings.enabled && settings.timezone.empty()) {
    callback(error(drogon::k400BadRequest, "reminders need your timezone"));
    return;
  }
  // And nobody the engine cannot reach may switch themselves on. A row saying "on" for someone
  // outside the allowlist is a promise the sweep will not keep — it would decide their week
  // honestly every Tuesday and withhold every one of them.
  if (settings.enabled && !sweep_->arming().allows(*caller)) {
    callback(error(drogon::k403Forbidden, "reminders aren't switched on for this account yet"));
    return;
  }
  // A PATCH that itself says enabled:true, landing on a row the provider suppressed, is the owner
  // saying "this address works now" — the one deliberate act that lifts that verdict, made with
  // their own hand on a session-authenticated route. Only that PATCH does it: one that leaves
  // reminders off, or only moves the timezone over a row already on, leaves the flag as the
  // provider left it. Being wrong costs exactly one more bounce, which suppresses again. The web
  // refetches after the 204 and the ordinary face returns.
  const bool turningOn = json->isMember("enabled") && settings.enabled;
  if (turningOn && settings.suppressed) reminders_->liftSuppression(*caller);
  if (!reminders_->upsertSettings(*caller, settings.enabled, settings.timezone)) {
    callback(error(drogon::k400BadRequest, "that doesn't look like a timezone"));
    return;
  }
  callback(noContent());
}

void RemindersApi::pause(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // Deliberately uncredentialed, and deliberately incapable of saying no. The secret came from
  // the reader's own mail; a token that matches nothing gets the same 204 as one that matches, so
  // this door can never be used to discover whose reminders exist.
  // The token is read only once it is known to BE a string: `{"token": []}` would otherwise throw
  // out of an uncredentialed handler and turn this door into an anonymous 500 generator.
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  const std::string secret =
      json && (*json)["token"].isString() ? (*json)["token"].asString() : std::string();
  if (!secret.empty()) {
    if (std::optional<UserId> user = reminders_->userByPauseDigest(tokens_->digestOf(secret)))
      reminders_->pause(*user);
  }
  callback(noContent());
}

void RemindersApi::unsubscribe(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // RFC 8058 one-click. A mail client POSTs this itself when the reader presses "unsubscribe", so
  // the credential is the same secret pause carries — carried in the query of the List-Unsubscribe
  // URL (a fragment would never reach us). Like pause it is uncredentialed and incapable of saying
  // no: a secret that matches nothing gets the same answer as one that matches, so this door is no
  // oracle either. Registered POST-only, so the prefetchers and scanners that GET every URL in a
  // mail can never unsubscribe anyone. A 200 with no body is what a one-click client expects back.
  const std::string secret = req->getParameter("t");
  if (!secret.empty()) {
    if (std::optional<UserId> user = reminders_->userByPauseDigest(tokens_->digestOf(secret)))
      reminders_->pause(*user);
  }
  callback(drogon::HttpResponse::newHttpResponse());
}

void RemindersApi::sweep(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // The operator's door, and it is closed unless REMINDERS_ADMIN_TOKEN says otherwise. An absent
  // token and a wrong one answer identically, so the route never advertises that it is there, and
  // the compare is constant-time so a wrong one cannot be guessed a byte at a time.
  if (adminToken_.empty() || !secretEqual(bearerOf(req), adminToken_)) {
    callback(error(drogon::k404NotFound, "no such endpoint"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (json && json->isMember("dryRun") && !(*json)["dryRun"].isBool()) {
    callback(error(drogon::k400BadRequest, "dryRun must be true or false"));
    return;
  }
  // isUInt64 rather than isNumeric: asUInt64() throws on a negative or fractional number just as
  // readily as on a string, and every one of those throws is the same anonymous 500.
  if (json && json->isMember("asOfMs") && !(*json)["asOfMs"].isUInt64()) {
    callback(error(drogon::k400BadRequest, "asOfMs must be a millisecond timestamp"));
    return;
  }
  const std::uint64_t asOfMs = json ? json->get("asOfMs", Json::Value::UInt64(0)).asUInt64() : 0;

  // Time travel is a rehearsal tool: without it every iteration of a weekly feature costs seven
  // real days. With the FEATURE armed it would let one request mail the fleet a week early, so it
  // is refused outright rather than quietly ignored.
  if (asOfMs != 0 && sweep_->arming().enabled) {
    callback(error(drogon::k409Conflict, "asOfMs is refused while reminders are enabled"));
    return;
  }
  // And a time-travelling sweep is ALWAYS a rehearsal. The pointer advance computes next week
  // from SQL now(), not from asOfMs, so a real run against a future clock would claim the whole
  // fleet's week and push every pointer forward against real time — one mistyped rehearsal
  // costing everybody their next reminder.
  const bool dryRun = asOfMs != 0 || (json && json->get("dryRun", false).asBool());

  // Never on this thread. A drogon IO thread serves every other request in flight; a full batch is
  // up to 200 users' worth of database round trips and provider calls, and parking one here would
  // pin a quarter of the server's capacity for as long as that takes. The sweep answers from its
  // own loop, which also serialises this run behind the heartbeat's rather than racing it.
  sweep_->runAsync(asOfMs != 0 ? asOfMs : clock_->nowMs(), dryRun,
                   [callback = std::move(callback)](MailSweepReport report) {
                     callback(jsonResponse(toJson(report)));
                   });
}

}
