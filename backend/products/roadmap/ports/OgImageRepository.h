#pragma once

#include <optional>
#include <string>

namespace wm {

// One rendered 1200×630 PNG per tree, keyed by tree id; the client renders the card and uploads it.
// Upsert replaces any prior card; get returns nullopt when a tree has never had one.
struct OgImageRepository {
  virtual ~OgImageRepository() = default;
  virtual void put(const std::string& treeId, const std::string& pngBytes) = 0;
  virtual std::optional<std::string> get(const std::string& treeId) = 0;
};

}
