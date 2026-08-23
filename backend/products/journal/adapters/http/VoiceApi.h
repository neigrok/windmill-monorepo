#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/Entitlements.h"
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
// ledger-backed account allowance the route reads beside this and by the process fuse.
enum class VoiceTake {
  ok,
  busy,   // too many takes already with the vendor: a wait
  spent,  // the day's bytes are gone: not a wait
};

class VoiceRation {
public:
  // Bytes off the day's bucket and a slot in both in-flight counters, taken together or not at all.
  VoiceTake take(const std::string& account, std::size_t bytes);
  // The slot back once the vendor has answered, however it answered. The bytes are not returned.
  void release(const std::string& account);

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
// wired the door answers 503. The vendor call does not hold this thread: everything refusable —
// plan, size, the day's ration, the account's AI allowance — is settled first, then the handler
// hands its callback to the transcriber and returns.
class VoiceApi {
public:
  VoiceApi(std::shared_ptr<Transcriber> transcriber, std::shared_ptr<Entitlements> entitlements,
           std::shared_ptr<AuthService> auth);

  void transcribe(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // POST /v1/journal/transcribe

private:
  std::shared_ptr<Transcriber> transcriber_;
  std::shared_ptr<Entitlements> entitlements_;
  std::shared_ptr<AuthService> auth_;
  VoiceRation ration_;
};

}
