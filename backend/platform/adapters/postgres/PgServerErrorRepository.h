#pragma once

#include "platform/ports/ServerErrorRepository.h"

#include <string>

namespace wm {

class PgServerErrorRepository : public ServerErrorRepository {
public:
  explicit PgServerErrorRepository(std::string connString);

  void insert(const std::string& method, const std::string& path, int status,
              const std::string& message) override;

private:
  std::string connString_;
};

}
