#include "platform/adapters/postgres/PgAccountFootprint.h"

#include "platform/adapters/postgres/PgPool.h"

#include <pqxx/pqxx>
#include <stdexcept>

namespace wm {

namespace {
bool isIdentifier(const std::string& name) {
  if (name.empty() || !(name[0] == '_' || (name[0] >= 'a' && name[0] <= 'z'))) return false;
  for (const char c : name)
    if (!(c == '_' || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
  return true;
}
}

PgAccountFootprint::PgAccountFootprint(std::shared_ptr<PgPool> pool, std::vector<OwnedTable> probes)
    : pool_(std::move(pool)) {
  if (probes.empty())
    throw std::invalid_argument("account footprint needs at least one probe — an unprobed deploy "
                                "would report every account empty");
  for (const OwnedTable& probe : probes) {
    if (!isIdentifier(probe.table) || !isIdentifier(probe.ownerColumn))
      throw std::invalid_argument("account footprint probe is not a plain identifier: " + probe.table +
                                  "." + probe.ownerColumn);
    if (!query_.empty()) query_ += " UNION ALL ";
    // Each branch is PARENTHESISED: a bare LIMIT inside a UNION arm is a Postgres syntax error.
    query_ += "(SELECT 1 FROM " + probe.table + " WHERE " + probe.ownerColumn + (probe.textOwner ? " = $1::uuid::text LIMIT 1)" : " = $1::uuid LIMIT 1)");
  }
  query_ = "SELECT 1 FROM (" + query_ + ") AS footprint LIMIT 1";
}

bool PgAccountFootprint::lockAndCheck(pqxx::transaction_base& txn, const UserId& userId) {
  txn.exec_params("SELECT id FROM users WHERE id=$1::uuid FOR UPDATE", userId.str());
  return !txn.exec_params(query_, userId.str()).empty();
}

bool PgAccountFootprint::anyData(const UserId& userId) {
  PgLease conn{*pool_};
  pqxx::work txn{*conn};
  return !txn.exec_params(query_, userId.str()).empty();
}

}
