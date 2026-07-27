#pragma once

#include <string>
#include <vector>

namespace wm {

// The server-side embedding boundary — echoes only; search embeds on-device. `configured()` is
// false when no upstream is wired (no key, no model), and the EchoSweep simply does not run: a
// missing embedder is a quiet no-op, never an error, exactly like PlanComposer behind paste-import.
// `embed` is synchronous on the sweep's own thread. The vendor-vs-self-hosted choice lives entirely
// behind this seam; a fake returns fixed vectors so the whole echo pass is testable without a model.
struct Embedder {
  virtual ~Embedder() = default;
  virtual bool configured() const = 0;
  virtual std::vector<float> embed(const std::string& body) = 0;
};

}
