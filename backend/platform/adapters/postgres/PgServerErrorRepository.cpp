#include "platform/adapters/postgres/PgServerErrorRepository.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>

namespace wm {

PgServerErrorRepository::PgServerErrorRepository(std::shared_ptr<PgPool> pool) : pool_(std::move(pool)) {}

void PgServerErrorRepository::insert(const std::string& method, const std::string& path, int status,
                                     const std::string& message) {
  // One row in one txn. actor is left null — the exception handler can't resolve a caller.
  pqxx::params params;
  params.append(method);
  params.append(path);
  params.append(status);
  params.append(message);

  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  txn.exec("INSERT INTO server_errors (method, path, status, message) VALUES ($1, $2, $3, $4)", params);
  txn.commit();
}

}
