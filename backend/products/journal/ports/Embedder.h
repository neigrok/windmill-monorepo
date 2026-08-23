#pragma once

#include <string>
#include <vector>

namespace wm {

// The embedding boundary — echoes only; on-device search embeds separately in the browser.
// `configured()` is false when no upstream is wired, and the sweep simply does not run: a missing
// embedder is a quiet no-op, never an error.
//
// Batched by design: one call per page carrying all of that page's passages, not one call per
// passage. A per-passage call would put an HTTP round trip on the sweep thread for every sentence
// in the journal.
//
// CORRECTED 2026-08-23: this used to claim the browser's search index is seeded from these vectors.
// It is not. Nothing serves a vector to any client — the search worker embeds page bodies on the
// device — so the two spaces are independent and either may move without breaking the other.
// Matching the browser's model, quantization, pooling and normalisation is still worth doing,
// because it makes one measurement describe both surfaces; it is a preference, not a contract.
struct Embedder {
  virtual ~Embedder() = default;
  virtual bool configured() const = 0;

  // Stamped on every span row. Retrieval must never compare vectors across versions: cosine between
  // two different embedding spaces is not degraded, it is meaningless, and nothing about it looks
  // like an error.
  virtual std::string version() const = 0;

  // One vector per input, in order. An empty result means the call FAILED — the page must be
  // retried rather than stored with no passages, which would be indistinguishable from a page
  // nobody wrote anything memorable on.
  virtual std::vector<std::vector<float>> embed(const std::vector<std::string>& passages) = 0;
};

}
