#pragma once

#include <string>
#include <vector>

namespace wm {

// `configured()` false means the sweep does not run: a missing embedder is a no-op, never an
// error. One call per page, carrying all of its passages.
struct Embedder {
  virtual ~Embedder() = default;
  virtual bool configured() const = 0;

  // Stamped on every span row. Never compare vectors across versions.
  virtual std::string version() const = 0;

  // One vector per input, in order. An empty result means the call failed — retry the page.
  virtual std::vector<std::vector<float>> embed(const std::vector<std::string>& passages) = 0;
};

}
