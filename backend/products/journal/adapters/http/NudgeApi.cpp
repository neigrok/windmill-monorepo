#include "products/journal/adapters/http/NudgeApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace wm {

namespace {
// A tap on the mail's pause link buys a week of silence — long enough to matter, short enough
// that the rhythm resumes without anyone having to remember to turn it back on.
constexpr std::uint64_t kPauseForMs = 7ULL * 24 * 60 * 60 * 1000;

drogon::HttpResponsePtr noContent() {
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  return response;
}

// One answer shape for GET and PATCH alike. `adaptive` is not a stored flag but the presence of a
// device-pushed schedule — a phone that has materialised the next knock has opted in, and clearing
// it is how a device says "never". `armed` is whether the engine can reach THIS caller (the
// dark-launch flag and their place on the allowlist), kept apart from `enabled` for the same reason
// roadmap keeps them apart: the caller's ask and the fleet's switch are different facts.
//
// `suppressed` is the third of those facts and the only one the reader did not choose: the provider
// told us their mailbox is gone (platform/adapters/email/ResendWebhookApi.h). It rides here for the
// same reason roadmap's does — someone whose nudges silently stopped is owed the reason, and a
// settings page that showed `enabled: true` while nothing ever arrived would be lying to them.
Json::Value toJson(const NudgeSettings& settings, bool armed) {
  Json::Value body(Json::objectValue);
  body["enabled"] = settings.enabled;
  body["channel"] = settings.channel;
  body["adaptive"] = settings.nextDueAtMs.has_value();
  if (settings.nextDueAtMs) body["nextDueAt"] = Json::Value::UInt64(*settings.nextDueAtMs);
  body["armed"] = armed;
  body["suppressed"] = settings.suppressed;
  return body;
}

Json::Value toJson(const NudgeSweepReport& report) {
  Json::Value body(Json::objectValue);
  body["sent"] = report.sent;
  body["skipped"] = report.skipped;
  body["held"] = report.held;
  body["failed"] = report.failed;
  return body;
}

std::string bearerOf(const drogon::HttpRequestPtr& req) {
  const std::string authorization = req->getHeader("authorization");
  if (authorization.rfind("Bearer ", 0) != 0) return "";
  return authorization.substr(7);
}
}

NudgeApi::NudgeApi(std::shared_ptr<NudgeRepository> nudges, std::shared_ptr<NudgeSweep> sweep,
                   std::shared_ptr<AuthService> auth, std::shared_ptr<TokenGenerator> tokens,
                   std::shared_ptr<Clock> clock, std::string adminToken)
    : nudges_(std::move(nudges)), sweep_(std::move(sweep)), auth_(std::move(auth)),
      tokens_(std::move(tokens)), clock_(std::move(clock)), adminToken_(std::move(adminToken)) {}

void NudgeApi::getSettings(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to read your nudge"));
    return;
  }
  // No row yet is not an error: it is the honest "off, and no device has set a rhythm", which is
  // exactly what the defaults say.
  cb(jsonResponse(toJson(nudges_->settingsFor(*caller).value_or(NudgeSettings{}),
                         sweep_->arming().allows(*caller))));
}

void NudgeApi::patchSettings(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to change your nudge"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json || !json->isObject()) {
    cb(error(drogon::k400BadRequest, "send the nudge fields to change"));
    return;
  }

  // A patch edits what is there: an absent field means "leave it alone", and a present one must be
  // the type it claims — jsoncpp throws on a conversion it cannot make, and an exception out of a
  // handler is an anonymous 500. The device PUSHES nextDueAt and slotDay: the server stores the
  // materialised schedule and fires it, but never derives it, so the rhythm stays on the phone.
  NudgeSettings settings = nudges_->settingsFor(*caller).value_or(NudgeSettings{});
  if (json->isMember("enabled")) {
    if (!(*json)["enabled"].isBool()) {
      cb(error(drogon::k400BadRequest, "enabled must be true or false"));
      return;
    }
    settings.enabled = (*json)["enabled"].asBool();
  }
  if (json->isMember("channel")) {
    if (!(*json)["channel"].isString()) {
      cb(error(drogon::k400BadRequest, "channel must be a string"));
      return;
    }
    settings.channel = (*json)["channel"].asString();
  }
  if (json->isMember("nextDueAt")) {
    if (!(*json)["nextDueAt"].isUInt64()) {
      cb(error(drogon::k400BadRequest, "nextDueAt must be a millisecond timestamp"));
      return;
    }
    settings.nextDueAtMs = (*json)["nextDueAt"].asUInt64();
  }
  if (json->isMember("slotDay")) {
    if (!(*json)["slotDay"].isString()) {
      cb(error(drogon::k400BadRequest, "slotDay must be YYYY-MM-DD"));
      return;
    }
    try {
      settings.slotDay = LocalDate((*json)["slotDay"].asString());
    } catch (const InvalidPage&) {
      cb(error(drogon::k400BadRequest, "slotDay must be YYYY-MM-DD"));
      return;
    }
  }
  if (json->isMember("pausedUntil")) {
    if (!(*json)["pausedUntil"].isUInt64()) {
      cb(error(drogon::k400BadRequest, "pausedUntil must be a millisecond timestamp"));
      return;
    }
    settings.pausedUntilMs = (*json)["pausedUntil"].asUInt64();
  }

  nudges_->upsertSettings(*caller, settings);
  cb(jsonResponse(toJson(settings, sweep_->arming().allows(*caller))));
}

void NudgeApi::pause(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // Deliberately uncredentialed and deliberately incapable of saying no: the only authority is the
  // per-send secret from the reader's own mail, and a secret that matches nothing gets the same 204
  // as one that matches, so this door can never be asked whose nudges exist.
  const std::string secret = bearerOf(req);
  if (!secret.empty()) {
    if (std::optional<UserId> user = nudges_->userByPauseDigest(tokens_->digestOf(secret)))
      nudges_->pause(*user, clock_->nowMs() + kPauseForMs);
  }
  cb(noContent());
}

void NudgeApi::unsubscribe(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // RFC 8058 one-click: the mail client POSTs this itself when the reader presses "unsubscribe",
  // so the secret rides the query of the List-Unsubscribe URL (a fragment would never reach us).
  // Registered POST-only, so the scanners and prefetchers that GET every URL in a mail can never
  // unsubscribe anyone — and like pause, it answers the same whether or not the secret matched.
  const std::string secret = req->getParameter("t");
  if (!secret.empty()) {
    if (std::optional<UserId> user = nudges_->userByPauseDigest(tokens_->digestOf(secret)))
      nudges_->disable(*user);
  }
  cb(noContent());
}

void NudgeApi::adminSweep(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // The operator's rehearsal door, closed unless the deploy set an admin token. The compare is
  // constant-time so a wrong token cannot be guessed a byte at a time.
  const std::string header = req->getHeader("x-admin-token");
  const std::string presented = header.empty() ? req->getParameter("token") : header;
  if (adminToken_.empty() || !secretEqual(presented, adminToken_)) {
    cb(error(drogon::k403Forbidden, "admin token required"));
    return;
  }

  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (json && json->isMember("dryRun") && !(*json)["dryRun"].isBool()) {
    cb(error(drogon::k400BadRequest, "dryRun must be true or false"));
    return;
  }
  // isUInt64 rather than isNumeric: asUInt64() throws on a negative or fractional number just as
  // readily as on a string, and every one of those throws would be a 500.
  if (json && json->isMember("asOfMs") && !(*json)["asOfMs"].isUInt64()) {
    cb(error(drogon::k400BadRequest, "asOfMs must be a millisecond timestamp"));
    return;
  }
  bool dryRun = json && json->get("dryRun", false).asBool();
  if (!dryRun && req->getParameter("dryRun") == "true") dryRun = true;
  std::uint64_t asOfMs = json ? json->get("asOfMs", Json::Value::UInt64(0)).asUInt64() : 0;
  const std::string asOfParam = req->getParameter("asOfMs");
  if (asOfMs == 0 && !asOfParam.empty()) {
    // stoull would happily wrap a "-5" and throw on junk; only plain digits pass, and the
    // try/catch keeps a 20-digit overflow a 400 rather than a 500.
    if (asOfParam.find_first_not_of("0123456789") != std::string::npos) {
      cb(error(drogon::k400BadRequest, "asOfMs must be a millisecond timestamp"));
      return;
    }
    try {
      asOfMs = std::stoull(asOfParam);
    } catch (const std::out_of_range&) {
      cb(error(drogon::k400BadRequest, "asOfMs must be a millisecond timestamp"));
      return;
    }
  }
  if (asOfMs == 0) asOfMs = clock_->nowMs();

  cb(jsonResponse(toJson(sweep_->run(asOfMs, dryRun))));
}

}
