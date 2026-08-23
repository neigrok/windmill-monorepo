#pragma once

#include <string>
#include <vector>

namespace wm {

// The embedding boundary — echoes only; on-device search embeds separately in the browser and the
// two vector spaces are independent. `configured()` false means the sweep does not run: a missing
// embedder is a no-op, never an error. Batched: one call per page carrying all of its passages.
struct Embedder {
  virtual ~Embedder() = default;
  virtual bool configured() const = 0;

  // Stamped on every span row. Never compare vectors across versions — cosine between two
  // embedding spaces is meaningless, not merely degraded.
  virtual std::string version() const = 0;

  // One vector per input, in order. An empty result means the call FAILED — retry the page rather
  // than store it with no passages.
  virtual std::vector<std::vector<float>> embed(const std::vector<std::string>& passages) = 0;
};

}
