#pragma once

#include "ports/EventRepository.h"

#include <string>

namespace wm {

class PgEventRepository : public EventRepository {
public:
  explicit PgEventRepository(std::string connString);

  void append(const std::string& sessionKey, const std::optional<UserId>& user,
              const std::vector<FunnelEvent>& events) override;

private:
  std::string connString_;
};

}
