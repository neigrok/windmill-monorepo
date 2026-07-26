#pragma once

#include <optional>
#include <string>

namespace wm {

// The store behind per-tree share cards (og-tree-cards): one rendered 1200×630 PNG per tree,
// keyed by tree id. The client renders the card and uploads it; this is the only place its
// bytes live. Upsert replaces any prior card; get returns the bytes, or nullopt when a tree
// has never had one — the read path serves the generic fallback in that case.
struct OgImageRepository {
  virtual ~OgImageRepository() = default;
  virtual void put(const std::string& treeId, const std::string& pngBytes) = 0;
  virtual std::optional<std::string> get(const std::string& treeId) = 0;
};

}
