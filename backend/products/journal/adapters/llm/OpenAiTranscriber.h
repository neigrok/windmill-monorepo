#pragma once

#include "platform/domain/AiFuse.h"
#include "platform/ports/AiUsageRepository.h"
#include "products/journal/ports/Transcriber.h"

#include <memory>
#include <string>
#include <trantor/net/EventLoopThread.h>

namespace wm {

// Talk, bought from OpenAI's gpt-4o-transcribe. Holds the API key and a private event loop the
// vendor call runs on: the request is sent, the CALLING THREAD RETURNS, and `done` fires on this
// loop when the vendor answers, so no drogon handler thread is parked.
//
// Honors the port's ephemeral contract: the audio is used for the single request and then it is
// gone — nothing here keeps a copy, and nothing here logs the audio or the transcript.
// configured() is true exactly when a key is present.
//
// The fuse and the sink arrive last and default to null, which is the no-op: the process fuse is
// asked before the upload, and what the reply reports is charged to the account's ledger after.
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
