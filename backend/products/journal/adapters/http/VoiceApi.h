#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/Entitlements.h"
#include "platform/ports/Clock.h"
#include "products/journal/ports/Transcriber.h"

#include <chrono>
#include <cstddef>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// What one take may weigh, under both the global body cap and the vendor's upload limit.
constexpr std::size_t kMaxAudioBytes = 6 * 1024 * 1024;

// What one account may talk in a day, counted in bytes.
constexpr std::size_t kVoiceBytesPerDay = 30 * 1024 * 1024;

// How many takes may be with the vendor at once; per account first, then for the process.
constexpr int kVoiceInFlightPerAccount = 2;
constexpr int kVoiceInFlightTotal = 8;

// May this take start: a byte bucket refilling at `kVoiceBytesPerDay` a day, plus the two in-flight
// counters. In memory and therefore best-effort — a deploy refills it. The money is held by the
// account's AI allowance and by the process fuse.
enum class VoiceTake {
  ok,
  busy,   // too many takes already with the vendor: a wait
  spent,  // the day's bytes are gone: not a wait
};

class VoiceRation {
public:
  // Bytes off the day's bucket and a slot in both in-flight counters, taken together or not at all.
  VoiceTake take(const std::string& account, std::size_t bytes);
  // The slot back once the take is over, however it ended. A heard take keeps its bytes spent; `unheardBytes` are
  // those of a take the vendor never heard, and go back on the day's bucket.
  void release(const std::string& account, std::size_t unheardBytes);

private:
  struct Talking {
    double bytesLeft = static_cast<double>(kVoiceBytesPerDay);
    std::chrono::steady_clock::time_point refilledAt{};
    int inFlight = 0;
  };

  std::mutex mutex_;
  std::unordered_map<std::string, Talking> held_;
  int inFlight_ = 0;
};

// Talk in, text back. The subscription is checked before any audio is looked at. The audio lives
// only in the request buffer and is never written anywhere; no page is created. With no vendor
// wired the door answers 503. The vendor call does not hold this thread: plan, size, the account's
// AI allowance as it reads now and the day's ration are settled first, then the handler hands its
// callback to the transcriber and returns. With durable allowances on, the transcriber's admission
// still decides — a take holds more than a read shows is left — and its refusal answers with the
// allowance's own code.
class VoiceApi {
public:
  VoiceApi(std::shared_ptr<Transcriber> transcriber, std::shared_ptr<Entitlements> entitlements,
           std::shared_ptr<AuthService> auth, std::shared_ptr<Clock> clock);

  void transcribe(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // POST /v1/journal/transcribe

private:
  // Null when the caller's allowance lets a take go on to admission.
  drogon::HttpResponsePtr allowanceRefusalBeforeAudio(const User& caller) const;
  // The answer to a take the transcriber's admission refused, under the code that refused it.
  drogon::HttpResponsePtr admissionRefusal(const User& caller, const std::string& code) const;

  std::shared_ptr<Transcriber> transcriber_;
  std::shared_ptr<Entitlements> entitlements_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<Clock> clock_;
  VoiceRation ration_;
};

}
