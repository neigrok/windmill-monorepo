#pragma once

#include "platform/domain/AiFuse.h"
#include "platform/ports/AiUsageRepository.h"
#include "products/journal/ports/Transcriber.h"

#include <json/json.h>
#include <trantor/net/EventLoopThread.h>

#include <memory>
#include <mutex>
#include <optional>
#include <string>

namespace wm {

class AiCallBudget;

constexpr const char* kOpenAiBaseUrl = "https://api.openai.com";

// The most one request to `model` can bill, held while it runs: its whole context window priced as input and its
// whole output ceiling as output, from the vendor's model page. A take's size bounds nothing — a lower bitrate packs
// more seconds into the same bytes — so the model's own limits are the bound. None for a model this does not know.
std::optional<long long> transcriptionCeilingNanos(const std::string& model);

// What the reply's `usage` says the request cost: the input and output tokens the vendor billed, at the model's
// rates. None when the object is absent, is not token usage, or carries a count no request reaches.
std::optional<long long> transcriptionActualNanos(const std::string& model, const Json::Value& usage);

// OpenAI's transcription endpoint on a private event loop: the calling thread returns and `done` fires on this loop,
// so no drogon handler thread is parked. The audio is used for one request and dropped; neither it nor the
// transcript is logged. With the AI allowance ledger (`budget`) a take holds its model's ceiling before any audio
// leaves and settles at what the vendor billed; configured() then also requires a model it can price. The fuse,
// the sink and the budget default to null, the no-op.
class OpenAiTranscriber : public Transcriber {
 public:
  ~OpenAiTranscriber() { stop(); }
  void stop() {
    std::call_once(stopped_, [this] {
      loop_.run();
      auto* loop = loop_.getLoop();
      loop->queueInLoop([loop] { loop->quit(); });
      loop_.wait();
    });
  }

  explicit OpenAiTranscriber(std::string apiKey, std::string model = "gpt-4o-transcribe",
                             std::shared_ptr<AiFuse> fuse = nullptr,
                             std::shared_ptr<UsageSink> usage = nullptr,
                             std::shared_ptr<AiCallBudget> budget = nullptr,
                             std::string baseUrl = kOpenAiBaseUrl);

  bool configured() const override;
  void transcribe(const UserId& user, const std::string& audio, const std::string& mimeType,
                  std::function<void(Transcription)> done) override;

 private:
  std::string apiKey_;
  std::string model_;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
  std::shared_ptr<AiCallBudget> budget_;
  std::string baseUrl_;
  std::once_flag stopped_;
  trantor::EventLoopThread loop_;
};

}
