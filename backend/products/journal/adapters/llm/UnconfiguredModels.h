#pragma once

#include "products/journal/ports/Curator.h"
#include "products/journal/ports/Embedder.h"
#include "products/journal/ports/Transcriber.h"

namespace wm {

// Unwired models make echo derivation a no-op and transcription answer 503.
struct NullCurator : Curator {
  bool configured() const override { return false; }
  std::string version() const override { return "none"; }
  Curation curate(const UserId&, const std::vector<Vectored>&, const std::vector<Vectored>&,
                  const std::vector<Pairing>&) override { return Curation{}; }
};

struct NullEmbedder : Embedder {
  bool configured() const override { return false; }
  std::string version() const override { return "none"; }
  std::vector<std::vector<float>> embed(const std::vector<std::string>&) override { return {}; }
};

struct NullTranscriber : Transcriber {
  bool configured() const override { return false; }
  void transcribe(const UserId&, const std::string&, const std::string&,
                  std::function<void(std::optional<Transcript>)> done) override {
    done(std::nullopt);
  }
};

}
