#pragma once

#include "platform/adapters/postgres/PgPool.h"

#include <memory>
#include <string>

namespace wm {

// The safety-net sink: persist one uncaught exception that escaped an HTTP/WS handler, so a
// broken endpoint is queryable in Postgres instead of only in a container's stdout. method and
// path are best-effort context; status is the response the client got (500). actor is omitted in
// v1 — the exception handler often can't resolve a caller.
//
// Concrete on purpose. Its one consumer is the drogon exception handler in the composition root,
// which holds it by value, not by reference: there is no seam here for a second implementation to
// enter through, so a port over it would be a vtable and a file that nothing chooses between.
class PgServerErrorRepository {
public:
  explicit PgServerErrorRepository(std::shared_ptr<PgPool> pool);

  void insert(const std::string& method, const std::string& path, int status,
              const std::string& message);

private:
  std::shared_ptr<PgPool> pool_;
};

}
