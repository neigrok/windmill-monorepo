#pragma once

#include "ports/OgImageRepository.h"

#include <optional>
#include <string>

namespace wm {

class PgOgImageRepository : public OgImageRepository {
public:
  explicit PgOgImageRepository(std::string connString);
  void put(const std::string& treeId, const std::string& pngBytes) override;
  std::optional<std::string> get(const std::string& treeId) override;

private:
  std::string connString_;
};

}
