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

// WHAT ONE TAKE MAY WEIGH. A talk take is a person speaking a paragraph into a phone: an opus
// stream at the bitrates MediaRecorder picks is roughly half a megabyte a minute, so 6 MB is ten
// minutes of continuous speech — past any take anybody records, and under both the global 8 MB body
// cap and OpenAI's own upload limit. Bigger than this is not a longer thought, it is a payload.
constexpr std::size_t kMaxAudioBytes = 6 * 1024 * 1024;

// WHAT ONE ACCOUNT MAY TALK IN A DAY, in bytes rather than minutes because bytes are what the
// server can count without asking the vendor. 30 MB is roughly an hour of speech — nobody journals
// by voice for an hour a day, and an account that tries is buying vendor time on a plan that
// currently cannot even be sold. A fuse, not a limit anyone is meant to meet.
constexpr std::size_t kVoiceBytesPerDay = 30 * 1024 * 1024;

// HOW MANY TAKES MAY BE WITH THE VENDOR AT ONCE. The vendor call no longer holds a handler thread,
// so these bound memory and vendor concurrency rather than the API's liveness: each one holds its
// audio in flight for as long as the vendor takes. Per account first, so one account cannot fill
// the process's share and leave every other writer refused.
constexpr int kVoiceInFlightPerAccount = 2;
constexpr int kVoiceInFlightTotal = 8;

// The day's talking, held per account: a byte bucket refilling at `kVoiceBytesPerDay` a day, plus
// the two in-flight counters. One object because they are one question — may this take start — and
// two would need two locks to answer it.
//
// It is IN MEMORY and therefore best-effort: a deploy refills it. What must be hard is the money,
// and the money is held by the ledger-backed account allowance the route reads beside this and by
// the process fuse the vendor edge reads (platform/domain/AiFuse.h). This is the fairness rung.
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

// One door: talk, get text back. It is a Windmill One feature, so the subscription is checked BEFORE
// any audio is looked at — a non-subscriber's bytes never reach the vendor. The audio lives only in
// the request buffer and is never written anywhere; the reply is text only (no page is created —
// the client drops the words into today's page with source = spoken). When no vendor is wired the
// door answers 503 and the client hides Talk.
//
// THE VENDOR CALL DOES NOT HOLD THIS THREAD. The handler hands its callback to the transcriber and
// returns; the reply is written from the transcriber's own loop when the vendor answers. Before that
// it settles everything refusable — the plan, the size, the day's ration, the account's AI
// allowance — because every one of those is cheaper than the upload it prevents.
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
