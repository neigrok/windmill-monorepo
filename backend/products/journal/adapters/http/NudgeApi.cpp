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
// A tap on the mail's pause link buys a week of silence.
constexpr std::uint64_t kPauseForMs = 7ULL * 24 * 60 * 60 * 1000;

drogon::HttpResponsePtr noContent() {
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  return response;
}

// One answer shape for GET and PATCH alike. `adaptive` is not a stored flag but the presence of a
// device-pushed schedule. `armed` is whether the engine can reach this caller, kept apart from
// `enabled`, which is the caller's own ask. `suppressed` is the provider saying the mailbox is gone.
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

// A dry run reports `wouldSend`; `sent` is what the provider accepted.
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
  // No row yet means off, with no device rhythm set.
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

  // An absent field means "leave it alone"; a present one must be the type it claims, or jsoncpp
  // throws out of the handler as a 500. The device pushes nextDueAt and slotDay: the server stores
  // the materialised schedule and fires it, never derives it.
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

  // Nobody the engine cannot reach may switch themselves on.
  if (settings.enabled && !sweep_->arming().allows(*caller)) {
    cb(error(drogon::k403Forbidden, "nudges aren't switched on for this account yet"));
    return;
  }
  // Only a PATCH that itself says enabled:true lifts a provider suppression; one saying
  // enabled:false, or moving the channel over a row already on, leaves the flag alone.
  // upsertSettings never writes that column, so the reply carries the lift itself.
  const bool turningOn = json->isMember("enabled") && settings.enabled;
  if (turningOn && settings.suppressed) {
    nudges_->liftSuppression(*caller);
    settings.suppressed = false;
  }
  nudges_->upsertSettings(*caller, settings);
  cb(jsonResponse(toJson(settings, sweep_->arming().allows(*caller))));
}

void NudgeApi::pause(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // Uncredentialed: the only authority is the per-send secret from the reader's own mail, and a
  // secret matching nothing gets the same 204, so this door cannot be asked whose nudges exist.
  const std::string secret = bearerOf(req);
  if (!secret.empty()) {
    if (std::optional<UserId> user = nudges_->userByPauseDigest(tokens_->digestOf(secret)))
      nudges_->pause(*user, clock_->nowMs() + kPauseForMs);
  }
  cb(noContent());
}

void NudgeApi::unsubscribe(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // RFC 8058 one-click: the mail client POSTs this, so the secret rides the query. POST-only, so a
  // scanner that GETs every URL in a mail cannot unsubscribe anyone, and it answers the same whether
  // or not the secret matched.
  const std::string secret = req->getParameter("t");
  if (!secret.empty()) {
    if (std::optional<UserId> user = nudges_->userByPauseDigest(tokens_->digestOf(secret)))
      nudges_->disable(*user);
  }
  cb(noContent());
}

void NudgeApi::adminSweep(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // Closed unless the deploy set an admin token; the compare is constant-time.
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
  // isUInt64 rather than isNumeric: asUInt64() throws on a negative or fractional number too.
  if (json && json->isMember("asOfMs") && !(*json)["asOfMs"].isUInt64()) {
    cb(error(drogon::k400BadRequest, "asOfMs must be a millisecond timestamp"));
    return;
  }
  bool dryRun = json && json->get("dryRun", false).asBool();
  if (!dryRun && req->getParameter("dryRun") == "true") dryRun = true;
  std::uint64_t asOfMs = json ? json->get("asOfMs", Json::Value::UInt64(0)).asUInt64() : 0;
  const std::string asOfParam = req->getParameter("asOfMs");
  if (asOfMs == 0 && !asOfParam.empty()) {
    // stoull would wrap a "-5"; only plain digits pass, and the catch keeps an overflow a 400.
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

  // Armed, a time-travelling sweep would mail the allowlist early and consume the genuine knock, so
  // it is refused outright rather than quietly ignored.
  if (asOfMs != 0 && sweep_->arming().enabled) {
    cb(error(drogon::k409Conflict, "asOfMs is refused while nudges are enabled"));
    return;
  }
  // A time-travelling sweep is always dry: decide() reads the slot against asOfMs while the claim
  // clears next_due_at against real time, so a wet run at a future clock burns every enabled user's
  // next slot.
  if (asOfMs != 0) dryRun = true;
  if (asOfMs == 0) asOfMs = clock_->nowMs();

  // Off this thread: a batch is up to 200 users of database round trips and Resend calls.
  sweep_->runAsync(asOfMs, dryRun, [cb = std::move(cb)](const MailSweepReport& report) {
    cb(jsonResponse(toJson(report)));
  });
}

}
