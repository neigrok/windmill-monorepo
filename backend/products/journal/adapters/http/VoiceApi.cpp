#include "products/journal/adapters/http/VoiceApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"

#include <json/value.h>

#include <algorithm>
#include <optional>
#include <utility>

namespace wm {

VoiceTake VoiceRation::take(const std::string& account, std::size_t bytes) {
  const std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> guard{mutex_};

  if (inFlight_ >= kVoiceInFlightTotal) return VoiceTake::busy;

  auto [entry, opened] = held_.try_emplace(account, Talking{});
  Talking& talking = entry->second;
  if (opened) talking.refilledAt = now;
  if (talking.inFlight >= kVoiceInFlightPerAccount) return VoiceTake::busy;

  // Refill first, so a bucket is judged at the instant it is asked about. Clamped at full: a bucket
  // nobody touched for a week is a fresh day, never a week's worth of credit.
  const double seconds = std::chrono::duration<double>(now - talking.refilledAt).count();
  talking.bytesLeft = std::min(static_cast<double>(kVoiceBytesPerDay),
                               talking.bytesLeft + seconds * kVoiceBytesPerDay / 86'400.0);
  talking.refilledAt = now;
  if (talking.bytesLeft < static_cast<double>(bytes)) return VoiceTake::spent;

  talking.bytesLeft -= static_cast<double>(bytes);
  ++talking.inFlight;
  ++inFlight_;
  return VoiceTake::ok;
}

void VoiceRation::release(const std::string& account) {
  std::lock_guard<std::mutex> guard{mutex_};
  auto entry = held_.find(account);
  if (entry != held_.end() && entry->second.inFlight > 0) --entry->second.inFlight;
  if (inFlight_ > 0) --inFlight_;
}

VoiceApi::VoiceApi(std::shared_ptr<Transcriber> transcriber,
                   std::shared_ptr<Entitlements> entitlements, std::shared_ptr<AuthService> auth)
    : transcriber_(std::move(transcriber)), entitlements_(std::move(entitlements)),
      auth_(std::move(auth)) {}

void VoiceApi::transcribe(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to talk"));
    return;
  }
  // The entitlement is read BEFORE the audio is touched, so a non-subscriber's bytes never reach the
  // vendor.
  if (!entitlements_->hasWindmillOne(caller->id, caller->email.value)) {
    cb(error(drogon::k403Forbidden, "talk is part of Windmill One"));
    return;
  }
  if (!transcriber_->configured()) {
    // No vendor wired: answer plainly rather than pretend a model exists. The client hides Talk.
    cb(error(drogon::k503ServiceUnavailable, "voice is not available right now"));
    return;
  }

  const std::string audio{req->getBody()};   // ephemeral: a request-scoped copy, never persisted
  if (audio.empty()) {
    cb(error(drogon::k400BadRequest, "no audio"));
    return;
  }
  if (audio.size() > kMaxAudioBytes) {
    cb(error(drogon::k413RequestEntityTooLarge, "that take is too long to transcribe"));
    return;
  }
  // OUR ceiling, not a sales door: an entitled account whose trailing-30-day AI spend is used up is
  // refused here rather than sent to the vendor. The dollar figure is never shown to anybody.
  if (!entitlements_->aiAllowanceFor(caller->id, caller->email.value).allows()) {
    cb(error(drogon::k429TooManyRequests, "talk has had its turn for now"));
    return;
  }
  const VoiceTake taken = ration_.take(caller->id.str(), audio.size());
  if (taken == VoiceTake::busy) {
    cb(error(drogon::k503ServiceUnavailable, "voice is busy right now"));
    return;
  }
  if (taken == VoiceTake::spent) {
    cb(error(drogon::k429TooManyRequests, "talk has had its turn for today"));
    return;
  }

  // Text out only — no page is created here. The callback fires on the transcriber's loop, and this
  // handler thread is already gone by then.
  const std::string account = caller->id.str();
  transcriber_->transcribe(
      caller->id, audio, req->getHeader("content-type"),
      [this, account, cb = std::move(cb)](std::optional<Transcript> transcript) {
        ration_.release(account);
        if (!transcript) {
          // A vendor failure is an outage, and it says so: answering 200 {"text":""} would make a
          // bad night at the vendor indistinguishable from a take that carried no words.
          cb(error(drogon::k502BadGateway, "the transcriber could not answer"));
          return;
        }
        Json::Value body(Json::objectValue);
        body["text"] = transcript->text;
        cb(jsonResponse(body));
      });
}

}
