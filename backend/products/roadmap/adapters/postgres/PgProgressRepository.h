#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/roadmap/ports/ProgressRepository.h"

#include <memory>
#include <string>

namespace wm {

class PgProgressRepository : public ProgressRepository {
public:
  explicit PgProgressRepository(std::shared_ptr<PgPool> pool);

  Progress load(const TreeId& tree, const UserId& user) override;
  void setStatus(const TreeId& tree, const UserId& user, const NodeId& node,
                 ProgressStatus status, const Hlc& at) override;
  std::map<TreeId, ProgressDigest> overlaysFor(const UserId& user) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
