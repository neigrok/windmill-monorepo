#pragma once

#include "platform/domain/AiFuse.h"
#include "platform/ports/AiUsageRepository.h"
#include "products/journal/ports/Transcriber.h"

#include <memory>
#include <string>
#include <trantor/net/EventLoopThread.h>

namespace wm {

// Talk, bought from OpenAI's gpt-4o-transcribe. Holds the API key and a private event loop that the
// vendor call runs on: the request is sent and the CALLING THREAD RETURNS: `done` fires on this
// loop when the vendor answers. Nothing parks a drogon handler thread, which is the difference
// between one person's slow upload and the whole API queueing behind it.
//
// Honors the port's ephemeral contract: the audio is used for the single request and then it is gone —
// nothing here keeps a copy, and nothing here logs the audio or the transcript. configured() is true
// exactly when a key is present, which is how main.cpp chooses this over the NullTranscriber that
// answers 503.
//
// The fuse and the sink arrive last and default to null, which is the no-op — the same discipline
// AnthropicCurator keeps. Voice is the product's second vendor call and the first one a person
// triggers directly, so it is metered exactly like the first: the process fuse is asked before the
// upload, and what the reply reports is charged to the account's ledger afterwards.
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
