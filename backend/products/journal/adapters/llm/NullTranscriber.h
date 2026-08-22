#pragma once

#include "products/journal/ports/Transcriber.h"

#include <utility>

namespace wm {

// The default transcriber when no ASR vendor is wired: configured() is false, so the transcribe
// endpoint answers 503 and the client hides the Talk control. A real vendor replaces this behind
// the Transcriber port; nothing else in the voice path moves.
struct NullTranscriber : Transcriber {
  bool configured() const override { return false; }
  void transcribe(const UserId&, const std::string&, const std::string&,
                  std::function<void(std::optional<Transcript>)> done) override {
    // Answers on the caller's thread, which is honest: nothing was sent anywhere. The route never
    // reaches here (configured() is false), so this is the floor rather than a path.
    done(std::nullopt);
  }
};

}
