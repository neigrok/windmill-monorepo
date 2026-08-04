#pragma once

#include "products/journal/ports/Embedder.h"

namespace wm {

// The default embedder when no upstream is wired: `configured()` is false, so the EchoSweep is a
// quiet no-op and echoes simply do not appear. A real model replaces this behind the same Embedder
// port; nothing else in the echo path moves.
struct NullEmbedder : Embedder {
  bool configured() const override { return false; }
  std::string version() const override { return "none"; }
  std::vector<std::vector<float>> embed(const std::vector<std::string>&) override { return {}; }
};

}
