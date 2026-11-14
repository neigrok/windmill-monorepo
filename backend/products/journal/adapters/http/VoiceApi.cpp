#include "products/journal/adapters/http/VoiceApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/json/AiBudgetJson.h"

#include <json/value.h>

#include <algorithm>
#include <array>
#include <optional>
#include <utility>

namespace wm {

namespace {

// The ledger's own refusals: each names a budget the allowance read can show.
constexpr std::array<AiBudgetCode, 8> kAllowanceRefusals{
    AiBudgetCode::SubjectExhausted, AiBudgetCode::FreeMonthExhausted, AiBudgetCode::FreeDayExhausted,
    AiBudgetCode::ConcurrencyExhausted, AiBudgetCode::FundingRequired, AiBudgetCode::DeviceBound,
    AiBudgetCode::DebtOutstanding, AiBudgetCode::Unconfigured};

// A spent individual allowance is the caller's own and answers 429; every other code is capacity the ledger has to
// give back first, 503. The allowance rides along, so a client can tell a spent period from a take larger than
// what is left.
drogon::HttpResponsePtr allowanceRefusal(const AiBudgetView& allowance) {
  const bool individual = allowance.code == AiBudgetCode::SubjectExhausted;
  const bool capacity = individual && allowance.remainingNanos > 0;
  Json::Value body(Json::objectValue);
  body["code"] = std::string(aiBudgetCodeName(allowance.code));
  body["reason"] = capacity ? "request_exceeds_remaining" : individual ? "allowance_exhausted" : "unavailable";
  body["error"] = capacity ? "a take needs more AI allowance than you have left"
      : individual ? "your AI allowance is fully used or reserved"
      : allowance.code == AiBudgetCode::FundingRequired ? "your plan has no funded AI allowance for this period"
      : allowance.code == AiBudgetCode::ConcurrencyExhausted ? "another AI request is still in progress"
      : "talk's AI allowance is unavailable right now";
  body["allowance"] = aiAllowanceJson(allowance);
  return jsonResponse(body, individual ? drogon::k429TooManyRequests : drogon::k503ServiceUnavailable);
}

drogon::HttpResponsePtr accountingUnavailable() {
  return error(drogon::k503ServiceUnavailable, "talk's AI allowance could not be checked right now",
               "ai_accounting_unavailable");
}

}

VoiceTake VoiceRation::take(const std::string& account, std::size_t bytes) {
  const std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> guard{mutex_};

  if (inFlight_ >= kVoiceInFlightTotal) return VoiceTake::busy;

  auto [entry, opened] = held_.try_emplace(account, Talking{});
  Talking& talking = entry->second;
  if (opened) talking.refilledAt = now;
  if (talking.inFlight >= kVoiceInFlightPerAccount) return VoiceTake::busy;

  // Refill first, clamped at full, so an untouched bucket is a fresh day and not a week of credit.
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

void VoiceRation::release(const std::string& account, std::size_t unheardBytes) {
  std::lock_guard<std::mutex> guard{mutex_};
  auto entry = held_.find(account);
  if (entry != held_.end()) {
    Talking& talking = entry->second;
    if (talking.inFlight > 0) --talking.inFlight;
    talking.bytesLeft = std::min(static_cast<double>(kVoiceBytesPerDay),
                                 talking.bytesLeft + static_cast<double>(unheardBytes));
  }
  if (inFlight_ > 0) --inFlight_;
}

VoiceApi::VoiceApi(std::shared_ptr<Transcriber> transcriber, std::shared_ptr<Entitlements> entitlements,
                   std::shared_ptr<AuthService> auth, std::shared_ptr<Clock> clock)
    : transcriber_(std::move(transcriber)), entitlements_(std::move(entitlements)), auth_(std::move(auth)),
      clock_(std::move(clock)) {}

drogon::HttpResponsePtr VoiceApi::allowanceRefusalBeforeAudio(const User& caller) const {
  if (!entitlements_->aiAllowancesEnabled()) {
    if (entitlements_->aiAllowanceFor(caller.id, caller.email.value).allows()) return nullptr;
    return error(drogon::k429TooManyRequests, "talk has had its turn for now");
  }
  try {
    const AiBudgetView allowance = entitlements_->aiAllowanceView(caller.id, caller.email.value);
    return allowance.code == AiBudgetCode::Ok ? nullptr : allowanceRefusal(allowance);
  } catch (...) {
    return accountingUnavailable();
  }
}

drogon::HttpResponsePtr VoiceApi::admissionRefusal(const User& caller, const std::string& code) const {
  if (code == "ai_accounting_unavailable") return accountingUnavailable();
  const auto refused = std::find_if(kAllowanceRefusals.begin(), kAllowanceRefusals.end(),
                                    [&](AiBudgetCode named) { return code == aiBudgetCodeName(named); });
  if (refused == kAllowanceRefusals.end())
    return error(drogon::k503ServiceUnavailable, "voice is not available right now", code.c_str());
  // Re-read under the code that refused the take: the read alone can still say there is room, since a take holds more.
  try {
    AiBudgetView allowance = entitlements_->aiAllowanceView(caller.id, caller.email.value);
    allowance.code = *refused;
    allowance.budgetResetsAtMs = aiBudgetReturnsAt(code, allowance.resetsAtMs, static_cast<long long>(clock_->nowMs()));
    return allowanceRefusal(allowance);
  } catch (...) {
    return accountingUnavailable();
  }
}

void VoiceApi::transcribe(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to talk"));
    return;
  }
  // Read before the audio is touched, so a non-subscriber's bytes never reach the vendor.
  if (!entitlements_->hasWindmillOne(caller->id, caller->email.value)) {
    cb(error(drogon::k403Forbidden, "talk is part of Windmill One"));
    return;
  }
  if (!transcriber_->configured()) {
    cb(error(drogon::k503ServiceUnavailable, "voice is not available right now", "voice_unavailable"));
    return;
  }

  const std::string audio{req->getBody()};   // request-scoped, never persisted
  if (audio.empty()) {
    cb(error(drogon::k400BadRequest, "no audio"));
    return;
  }
  if (audio.size() > kMaxAudioBytes) {
    cb(error(drogon::k413RequestEntityTooLarge, "that take is too long to transcribe"));
    return;
  }
  if (drogon::HttpResponsePtr refusal = allowanceRefusalBeforeAudio(*caller)) {
    cb(refusal);
    return;
  }
  const VoiceTake taken = ration_.take(caller->id.str(), audio.size());
  if (taken == VoiceTake::busy) {
    cb(error(drogon::k503ServiceUnavailable, "voice is busy right now", "voice_busy"));
    return;
  }
  if (taken == VoiceTake::spent) {
    cb(error(drogon::k429TooManyRequests, "talk has had its turn for today"));
    return;
  }

  // Text out only; the callback fires on the transcriber's loop, after this handler thread is gone, or here when
  // admission refuses the take before its audio leaves.
  transcriber_->transcribe(
      caller->id, audio, req->getHeader("content-type"),
      [this, caller = *caller, bytes = audio.size(), cb = std::move(cb)](Transcription take) {
        // A refused take never reached the vendor, so its bytes go back on the day's bucket.
        ration_.release(caller.id.str(), take.refusal.empty() ? 0 : bytes);
        if (take.text) {
          Json::Value body(Json::objectValue);
          body["text"] = *take.text;
          cb(jsonResponse(body));
          return;
        }
        if (!take.refusal.empty()) {
          cb(admissionRefusal(caller, take.refusal));
          return;
        }
        // A vendor failure answers as an outage, distinct from a take that carried no words.
        cb(error(drogon::k502BadGateway, "the transcriber could not answer"));
      });
}

}
