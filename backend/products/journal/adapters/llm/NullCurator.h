#pragma once

#include "products/journal/ports/Curator.h"

namespace wm {

// The default curator when no upstream is wired: `configured()` is false, so the sweep is a quiet
// no-op and no echo is ever written. A real vendor replaces this behind the same port; nothing
// else in the pipeline moves.
struct NullCurator : Curator {
  bool configured() const override { return false; }
  std::string version() const override { return "none"; }
  Curation curate(const UserId&, const std::vector<Vectored>&, const std::vector<Vectored>&,
                  const std::vector<Pairing>&) override {
    return Curation{};   // ok = false: never mistaken for "looked, and found nothing"
  }
};

}
