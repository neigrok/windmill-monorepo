#pragma once

#include "products/journal/ports/Transcriber.h"

#include <utility>

namespace wm {

// No ASR vendor wired: configured() is false, so the transcribe endpoint answers 503.
struct NullTranscriber : Transcriber {
  bool configured() const override { return false; }
  void transcribe(const UserId&, const std::string&, const std::string&,
                  std::function<void(std::optional<Transcript>)> done) override {
    done(std::nullopt);
  }
};

}
