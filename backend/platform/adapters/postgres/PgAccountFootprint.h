#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/ports/AccountFootprint.h"

#include <memory>
#include <string>
#include <vector>

namespace wm {

// One product's answer to "does this account hold anything": the table its rows live in and the
// column that owns them.
struct OwnedTable {
  std::string table;
  std::string ownerColumn;
};

// Every probe in one statement: a UNION ALL of bounded existence checks, so the whole question
// costs a single round trip and stops at the first row anything returns.
class PgAccountFootprint : public AccountFootprint {
public:
  // Identifiers cannot be bound as parameters, so they are spliced — and validated here at
  // construction against [a-z_][a-z0-9_]*. A malformed probe takes the server down at boot.
  PgAccountFootprint(std::shared_ptr<PgPool> pool, std::vector<OwnedTable> probes);

  bool anyData(const UserId& userId) override;

private:
  std::shared_ptr<PgPool> pool_;
  std::string query_;
};

}
