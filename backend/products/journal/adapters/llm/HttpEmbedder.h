#pragma once

#include "products/journal/ports/Embedder.h"

#include <trantor/net/EventLoopThread.h>

#include <mutex>
#include <string>
#include <vector>

namespace wm {

// bge-small-en-v1.5, q8, mean-pooled and L2-normalised — run by the Node sidecar in
// services/embedder over the very model files the web app serves, and reached over plain HTTP.
//
// The sidecar exists so that these vectors and the ones the browser produces for journal search
// come from the same library over the same bytes; services/embedder/check/browser.mjs measures
// that against the shipped browser worker in real Chrome.
//
// Unconfigured (no JOURNAL_EMBEDDER_URL) is a resting state, not a failure: configured() answers
// false and the whole echo sweep is a quiet no-op.
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
