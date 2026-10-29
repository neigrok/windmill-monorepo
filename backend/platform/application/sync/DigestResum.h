#pragma once

#include "platform/application/sync/SyncCatalog.h"
#include "platform/domain/sync/Digest.h"
#include "platform/domain/sync/Scope.h"
#include "platform/ports/SyncStore.h"

#include <optional>

namespace wm::sync {

// What one resum found: the digest the scope's row held and the §6.12 sum over its feed rows.
struct Resum {
  Digest256 stored;
  Digest256 summed;

  bool moved() const { return stored != summed; }
};

// §6.12 recomputed from scratch for one alive scope: the sum over every type's feed rows, stored in its
// row under the scope lock with seq, counters and open left as they were. A registry change that drops
// or renames a lattice field changes h(r) for every row that carried it, and admission only ever moves
// the stored digest by a difference, so nothing but this brings a stored digest back to its rows.
class DigestResum {
public:
  DigestResum(const SyncCatalog& catalog, SyncStore& store);

  // One transaction per scope: admission moves a digest by −h(before)+h(after) from whatever base it
  // finds, so a scope summed and committed stays right under the writes that follow, and one not yet
  // summed stays off by the same amount until its turn. Nullopt for a scope that is absent or dead
  // (a dead scope's digest is never sent; G5 sets it to 0). Throws for a scope whose kind and product
  // the catalog declares no type of, which an empty sum would otherwise zero.
  std::optional<Resum> resum(const ScopeKey& key);

private:
  const SyncCatalog& catalog_;
  SyncStore& store_;
};

}
