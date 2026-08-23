#pragma once

#include <optional>
#include <string>

namespace wm {

// The bytes of a stored share video and the container mime detected at upload. Returned by get,
// so the serve path can echo the exact type the scraper's og:video tag was promised.
struct StoredVideo {
  std::string bytes;
  std::string mime;
};

// The store behind per-tree share videos: one short mp4/webm loop per tree, keyed by tree id, and
// the only place its bytes live. Upsert replaces any prior video; get returns the bytes and their
// mime, or nullopt when a tree has never had one — the share page keeps the og:image poster as the
// fallback there. has answers "does this tree carry a video?" without dragging the bytes off disk.
struct OgVideoRepository {
  virtual ~OgVideoRepository() = default;
  virtual void put(const std::string& treeId, const std::string& bytes, const std::string& mime) = 0;
  virtual std::optional<StoredVideo> get(const std::string& treeId) = 0;
  virtual bool has(const std::string& treeId) = 0;
};

}
