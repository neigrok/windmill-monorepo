#pragma once

#include "products/journal/ports/Embedder.h"

namespace wm {

// No upstream wired: `configured()` is false, so EchoSweep is a no-op.
struct NullEmbedder : Embedder {
  bool configured() const override { return false; }
  std::string version() const override { return "none"; }
  std::vector<std::vector<float>> embed(const std::vector<std::string>&) override { return {}; }
};

}
