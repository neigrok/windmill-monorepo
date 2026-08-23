#pragma once

#include "products/journal/ports/Transcriber.h"

#include <utility>

namespace wm {

// The default transcriber when no ASR vendor is wired: configured() is false, so the transcribe
// endpoint answers 503 and the client hides the Talk control.
struct NullTranscriber : Transcriber {
  bool configured() const override { return false; }
  void transcribe(const UserId&, const std::string&, const std::string&,
                  std::function<void(std::optional<Transcript>)> done) override {
    // Answers on the caller's thread: nothing was sent anywhere.
    done(std::nullopt);
  }
};

}
