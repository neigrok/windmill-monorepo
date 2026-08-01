#pragma once

#include "platform/ports/AccountFootprint.h"

#include <string>
#include <vector>

namespace wm {

// One product's answer to "does this account hold anything": the table its rows live in and the
// column that owns them. Products are named where products are already named — the composition
// root — so platform learns that a probe is a table, and never which tables a product keeps.
struct OwnedTable {
  std::string table;
  std::string ownerColumn;
};

// Every probe in one statement: a UNION ALL of bounded existence checks, so the whole question
// costs a single round trip and stops at the first row anything returns.
class PgAccountFootprint : public AccountFootprint {
public:
  // Identifiers cannot be bound as parameters, so they are spliced — and therefore validated here,
  // at construction, against a plain [a-z_][a-z0-9_]* shape. A malformed probe is a wiring error
  // and takes the server down at boot rather than reaching a query.
  PgAccountFootprint(std::string connString, std::vector<OwnedTable> probes);

  bool anyData(const UserId& userId) override;

private:
  std::string connString_;
  std::string query_;
};

}
