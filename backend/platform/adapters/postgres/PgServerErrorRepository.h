#pragma once

#include "platform/adapters/postgres/PgPool.h"

#include <memory>
#include <string>

namespace wm {

// The safety-net sink: persist one uncaught exception that escaped an HTTP/WS handler. method and
// path are best-effort context; status is the response the client got (500). actor is omitted —
// the exception handler often can't resolve a caller.
class PgServerErrorRepository {
public:
  explicit PgServerErrorRepository(std::shared_ptr<PgPool> pool);

  void insert(const std::string& method, const std::string& path, int status,
              const std::string& message);

private:
  std::shared_ptr<PgPool> pool_;
};

}
