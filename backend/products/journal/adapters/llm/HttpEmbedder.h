#pragma once

#include "products/journal/ports/Embedder.h"

#include <trantor/net/EventLoopThread.h>

#include <mutex>
#include <string>
#include <vector>

namespace wm {

// bge-small-en-v1.5, q8, mean-pooled and L2-normalised, served by the Node sidecar in
// services/embedder over plain HTTP. No JOURNAL_EMBEDDER_URL means configured() is false and the
// echo sweep is a no-op, not an error.
class HttpEmbedder : public Embedder {
public:
  explicit HttpEmbedder(std::string baseUrl);

  bool configured() const override;
  std::string version() const override;
  std::vector<std::vector<float>> embed(const std::vector<std::string>& passages) override;

private:
  // False when the sidecar changed model under a running sweep.
  bool rememberVersion(const std::string& reported) const;

  std::string origin_;   // scheme://host[:port] — what drogon dials
  std::string prefix_;   // any path a reverse proxy mounted us under, "" in the usual case
  mutable std::mutex mutex_;
  mutable std::string version_;
  trantor::EventLoopThread loop_;
};

}
