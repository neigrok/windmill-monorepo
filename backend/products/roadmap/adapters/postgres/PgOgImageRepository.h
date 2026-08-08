#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/ports/OgImageRepository.h"

#include <memory>
#include <optional>
#include <string>

namespace wm {

class PgOgImageRepository : public OgImageRepository {
public:
  explicit PgOgImageRepository(std::shared_ptr<PgPool> pool);
  void put(const std::string& treeId, const std::string& pngBytes) override;
  std::optional<std::string> get(const std::string& treeId) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
