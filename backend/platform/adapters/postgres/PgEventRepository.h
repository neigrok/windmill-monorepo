#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/EventRepository.h"

#include <memory>
#include <string>

namespace wm {

class PgEventRepository : public EventRepository {
public:
  explicit PgEventRepository(std::shared_ptr<PgPool> pool);

  void append(const std::string& sessionKey, const std::optional<UserId>& user,
              const std::vector<FunnelEvent>& events) override;

private:
  std::shared_ptr<PgPool> pool_;
};

}
