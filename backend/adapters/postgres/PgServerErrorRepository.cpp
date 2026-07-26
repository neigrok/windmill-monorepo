#include "adapters/postgres/PgServerErrorRepository.h"

#include "adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

namespace wm {

PgServerErrorRepository::PgServerErrorRepository(std::string connString) : connString_(std::move(connString)) {}

void PgServerErrorRepository::insert(const std::string& method, const std::string& path, int status,
                                     const std::string& message) {
  // One row in one txn. actor is left null in v1 — the exception handler can't resolve a caller.
  pqxx::params params;
  params.append(method);
  params.append(path);
  params.append(status);
  params.append(message);

  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec("INSERT INTO server_errors (method, path, status, message) VALUES ($1, $2, $3, $4)", params);
  txn.commit();
}

}
