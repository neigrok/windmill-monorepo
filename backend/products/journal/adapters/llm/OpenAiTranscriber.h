#pragma once

#include "platform/domain/AiFuse.h"
#include "platform/ports/AiUsageRepository.h"
#include "products/journal/ports/Transcriber.h"

#include <memory>
#include <string>
#include <trantor/net/EventLoopThread.h>

namespace wm {

// OpenAI gpt-4o-transcribe on a private event loop: the calling thread returns and `done` fires on
// this loop, so no drogon handler thread is parked. The audio is used for one request and dropped;
// neither it nor the transcript is logged. configured() is true exactly when a key is present.
// The fuse and the sink default to null, the no-op.
class OpenAiTranscriber : public Transcriber {
 public:
  explicit OpenAiTranscriber(std::string apiKey, std::string model = "gpt-4o-transcribe",
                             std::shared_ptr<AiFuse> fuse = nullptr,
                             std::shared_ptr<UsageSink> usage = nullptr);

  bool configured() const override;
  void transcribe(const UserId& user, const std::string& audio, const std::string& mimeType,
                  std::function<void(std::optional<Transcript>)> done) override;

 private:
  std::string apiKey_;
  std::string model_;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
  trantor::EventLoopThread loop_;
};

}
