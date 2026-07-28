#pragma once

#include "products/journal/ports/Transcriber.h"

#include <trantor/net/EventLoopThread.h>

#include <string>

namespace wm {

// Talk, bought from OpenAI's gpt-4o-transcribe. Holds the API key and a private event loop so the one
// blocking vendor call runs off the request loop, never stalling it on itself. Honors the port's
// ephemeral contract: the audio is used for the single request and then it is gone — nothing here keeps
// a copy, and nothing here logs the audio or the transcript. configured() is true exactly when a key is
// present, which is how main.cpp chooses this over the NullTranscriber that answers 503.
class OpenAiTranscriber : public Transcriber {
 public:
  explicit OpenAiTranscriber(std::string apiKey, std::string model = "gpt-4o-transcribe");

  bool configured() const override;
  Transcript transcribe(const std::string& audio, const std::string& mimeType) override;

 private:
  std::string apiKey_;
  std::string model_;
  trantor::EventLoopThread loop_;
};

}
