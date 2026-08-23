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
// An IANA name is short by construction; anything longer is not a timezone.
constexpr std::size_t kMaxTimezoneBytes = 64;

drogon::HttpResponsePtr noContent() {
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  return response;
}

// `armed` is whether the engine can reach THIS CALLER — the flag AND the allowlist — while
// `enabled` is what they asked for.
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
  // No row yet is not an error: the defaults say "off, and we don't know where you are".
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

  // An absent field means "leave it alone"; a present one must be the type it claims, since
  // jsoncpp throws on a conversion it cannot make.
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
  // Without a zone there is no hour to send at, so enabling without one is refused.
  if (settings.enabled && settings.timezone.empty()) {
    callback(error(drogon::k400BadRequest, "reminders need your timezone"));
    return;
  }
  // Nobody the engine cannot reach may switch themselves on: a row saying "on" for someone
  // outside the allowlist is a promise the sweep will not keep.
  if (settings.enabled && !sweep_->arming().allows(*caller)) {
    callback(error(drogon::k403Forbidden, "reminders aren't switched on for this account yet"));
    return;
  }
  // A PATCH that itself says enabled:true, over a row the provider suppressed, is the one act
  // that lifts that verdict; any other PATCH leaves the flag as the provider left it.
  const bool turningOn = json->isMember("enabled") && settings.enabled;
  if (!reminders_->upsertSettings(*caller, settings.enabled, settings.timezone)) {
    callback(error(drogon::k400BadRequest, "that doesn't look like a timezone"));
    return;
  }
  // Lifted only once the settings landed: a refused timezone must not discard the provider's
  // verdict on the way to a 400.
  if (turningOn && settings.suppressed) reminders_->liftSuppression(*caller);
  callback(noContent());
}

void RemindersApi::pause(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // Uncredentialed and incapable of saying no: a token matching nothing gets the same 204, so
  // this door discovers nothing. The token is read only once it is known to BE a string.
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
  // RFC 8058 one-click: the credential is the same secret pause carries, in the QUERY of the
  // List-Unsubscribe URL (a fragment would never reach us). Uncredentialed and no oracle, like
  // pause, and POST-only so a scanner's GET unsubscribes nobody. A one-click client expects a 200
  // with no body.
  const std::string secret = req->getParameter("t");
  if (!secret.empty()) {
    if (std::optional<UserId> user = reminders_->userByPauseDigest(tokens_->digestOf(secret)))
      reminders_->pause(*user);
  }
  callback(drogon::HttpResponse::newHttpResponse());
}

void RemindersApi::sweep(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // Closed unless REMINDERS_ADMIN_TOKEN says otherwise. An absent token and a wrong one answer
  // identically, and the compare is constant-time.
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
  // readily as on a string.
  if (json && json->isMember("asOfMs") && !(*json)["asOfMs"].isUInt64()) {
    callback(error(drogon::k400BadRequest, "asOfMs must be a millisecond timestamp"));
    return;
  }
  const std::uint64_t asOfMs = json ? json->get("asOfMs", Json::Value::UInt64(0)).asUInt64() : 0;

  // With the FEATURE armed, time travel would mail the fleet a week early: refuse it outright.
  if (asOfMs != 0 && sweep_->arming().enabled) {
    callback(error(drogon::k409Conflict, "asOfMs is refused while reminders are enabled"));
    return;
  }
  // A time-travelling sweep is ALWAYS a rehearsal: the pointer advance computes next week from
  // SQL now(), so a real run against a future clock would claim the whole fleet's week.
  const bool dryRun = asOfMs != 0 || (json && json->get("dryRun", false).asBool());

  // Never on this thread: a full batch is hundreds of database round trips and provider calls,
  // and parking it here would hold one of the server's few IO threads and its pooled connection.
  // The sweep's own loop also serialises this run behind the heartbeat's rather than racing it.
  sweep_->runAsync(asOfMs != 0 ? asOfMs : clock_->nowMs(), dryRun,
                   [callback = std::move(callback)](MailSweepReport report) {
                     callback(jsonResponse(toJson(report)));
                   });
}

}
