#pragma once

#include <string>

namespace wm {

// The safety-net sink: persist one uncaught exception that escaped an HTTP/WS handler, so a
// broken endpoint is queryable in Postgres instead of only in a container's stdout. method and
// path are best-effort context; status is the response the client got (500). actor is omitted in
// v1 — the exception handler often can't resolve a caller.
struct ServerErrorRepository {
  virtual ~ServerErrorRepository() = default;
  virtual void insert(const std::string& method, const std::string& path, int status,
                      const std::string& message) = 0;
};

}
