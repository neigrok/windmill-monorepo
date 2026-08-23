#pragma once

#include "products/journal/ports/Curator.h"

namespace wm {

// No upstream wired: `configured()` is false, so the sweep is a no-op and no echo is written.
struct NullCurator : Curator {
  bool configured() const override { return false; }
  std::string version() const override { return "none"; }
  Curation curate(const UserId&, const std::vector<Vectored>&, const std::vector<Vectored>&,
                  const std::vector<Pairing>&) override {
    return Curation{};   // ok = false: never mistaken for "looked, and found nothing"
  }
};

}
