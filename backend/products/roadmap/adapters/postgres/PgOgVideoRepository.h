#pragma once

#include "products/roadmap/ports/OgVideoRepository.h"

#include <optional>
#include <string>

namespace wm {

class PgOgVideoRepository : public OgVideoRepository {
public:
  explicit PgOgVideoRepository(std::string connString);
  void put(const std::string& treeId, const std::string& bytes, const std::string& mime) override;
  std::optional<StoredVideo> get(const std::string& treeId) override;
  bool has(const std::string& treeId) override;

private:
  std::string connString_;
};

}
