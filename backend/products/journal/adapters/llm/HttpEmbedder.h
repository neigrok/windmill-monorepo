#pragma once

#include "products/journal/ports/Embedder.h"

#include <trantor/net/EventLoopThread.h>

#include <mutex>
#include <string>
#include <vector>

namespace wm {

// bge-small-en-v1.5, q8, mean-pooled and L2-normalised — run by the Node sidecar in services/embedder
// over the very model files the web app serves, and reached over plain HTTP from here.
//
// The sidecar exists because the vectors this port produces are compared against vectors the browser
// produced: the same model runs on-device for journal search. Reimplementing its tokenizer, pooling
// and normalisation in C++ would put that identity in the hands of a subtle bug that raises no error
// and never fails a test — it would simply make retrieval quietly worse forever. Running the same
// library over the same bytes makes the identity structural instead of hoped-for, and it is measured:
// services/embedder/check/browser.mjs puts five sentences through the shipped browser worker in real
// Chrome and compares them against the sidecar's own committed vectors.
//
// Unconfigured (no JOURNAL_EMBEDDER_URL) is a resting state, not a failure: configured() answers
// false and the whole echo sweep is a quiet no-op, exactly as with the NullEmbedder.
class HttpEmbedder : public Embedder {
public:
  explicit HttpEmbedder(std::string baseUrl);

  bool configured() const override;
  std::string version() const override;
  std::vector<std::vector<float>> embed(const std::vector<std::string>& passages) override;

private:
  // The single writer of the stamp every span row carries, and the one place that notices it moving.
  // Returns false when the sidecar has changed model under a running sweep.
  bool rememberVersion(const std::string& reported) const;

  std::string origin_;   // scheme://host[:port] — what drogon dials
  std::string prefix_;   // any path a reverse proxy mounted us under, "" in the usual case
  mutable std::mutex mutex_;
  mutable std::string version_;
  trantor::EventLoopThread loop_;
};

}
