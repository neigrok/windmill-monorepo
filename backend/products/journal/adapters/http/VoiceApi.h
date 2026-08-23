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

// What one take may weigh. An opus stream at the bitrates MediaRecorder picks is roughly half a
// megabyte a minute, so 6 MB is ten minutes of continuous speech — under both the global 8 MB body
// cap and OpenAI's own upload limit.
constexpr std::size_t kMaxAudioBytes = 6 * 1024 * 1024;

// What one account may talk in a day, in bytes rather than minutes because bytes are what the
// server can count without asking the vendor. 30 MB is roughly an hour of speech: a fuse, not a
// limit anyone is meant to meet.
constexpr std::size_t kVoiceBytesPerDay = 30 * 1024 * 1024;

// How many takes may be with the vendor at once. They bound memory and vendor concurrency: each
// holds its audio in flight for as long as the vendor takes. Per account first, so one account
// cannot fill the process's share.
constexpr int kVoiceInFlightPerAccount = 2;
constexpr int kVoiceInFlightTotal = 8;

// The day's talking, held per account: a byte bucket refilling at `kVoiceBytesPerDay` a day, plus
// the two in-flight counters. One object because they are one question — may this take start.
//
// It is IN MEMORY and therefore best-effort: a deploy refills it. The money is held instead by the
// ledger-backed account allowance the route reads beside this and by the process fuse the vendor
// edge reads (platform/domain/AiFuse.h). This is the fairness rung.
enum class VoiceTake {
  ok,
  busy,   // too many takes already with the vendor — a wait, and the route says so
  spent,  // the day's bytes are gone — not a wait, and saying "busy" would be a lie
};

class VoiceRation {
public:
  // Bytes off the day's bucket AND a slot in both in-flight counters, taken together or not at all.
  // Anything but `ok` means the caller must not have started anything.
  VoiceTake take(const std::string& account, std::size_t bytes);
  // The slot back when the vendor has answered, however it answered. The bytes are NOT returned: the
  // upload happened, and a failed transcription is one we were still charged for.
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

// One door: talk, get text back. A Windmill One feature, so the subscription is checked BEFORE any
// audio is looked at — a non-subscriber's bytes never reach the vendor. The audio lives only in the
// request buffer and is never written anywhere; the reply is text only, and no page is created.
// When no vendor is wired the door answers 503 and the client hides Talk.
//
// THE VENDOR CALL DOES NOT HOLD THIS THREAD. The handler hands its callback to the transcriber and
// returns; the reply is written from the transcriber's own loop. Before that it settles everything
// refusable — the plan, the size, the day's ration, the account's AI allowance.
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
