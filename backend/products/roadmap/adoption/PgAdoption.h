#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/application/sync/SyncCatalog.h"
#include "platform/ports/SyncStore.h"
#include "products/roadmap/adoption/Adoption.h"
#include "products/roadmap/adoption/Audit.h"

#include <memory>
#include <string>
#include <vector>

// The adoption on Postgres: roadmap's own tables read whole, one owner's plan written into the engine's tables through
// the binding's stores, the engine's tables read back through the binding, and every scope's digest summed from its rows.

namespace wm::roadmap::adoption {

// What writing one owner's plan did: the roadmaps it adopted, and those whose `tree` record it found already there.
struct Written {
  std::size_t adopted = 0;
  std::size_t already = 0;
};

// One alive scope's §6.12 sum against the digest its row holds, and whether its seq stands at or past every row's.
struct Summed {
  sync::ScopeKey key;
  bool digestHolds = false;
  bool seqHolds = false;
};

class PgAdoption {
public:
  PgAdoption(std::shared_ptr<PgPool> pool, const sync::SyncCatalog& catalog, sync::SyncStore& store);

  // Every roadmap of roadmap's own tables, a roadmap stored only as a whole document unfolded into rows as the old server
  // unfolds it, its links as the old server reads them; and every account.
  OldDatabase oldTables();

  // The house account, inserted when absent; false when its address names another account, which stops the move.
  bool houseStands();

  // One transaction: under the move's lock and the owner's account held, each of the owner's roadmaps whose `tree` record
  // no row holds is written, its record into the owner's roadmap scope at that scope's next seqs, its tree scope and its
  // overlays as the plan has them. A roadmap whose record is there is left as it is, so a second run writes nothing.
  // Throws, writing nothing, when the owner's account is gone or a scope the plan creates is already there.
  Written write(const OwnerPlan& owner);

  // Every account whose roadmap scope holds a `tree` record.
  std::vector<UserId> owners();
  // One owner's roadmaps as the engine's tables hold them, read through the binding in one snapshot.
  std::vector<EngineRoadmap> roadmapsOf(const UserId& owner);
  // Whether a `tree` record of the id is there, alive or dead.
  bool adopted(const std::string& tree);

  // Every alive scope the catalog binds a type of, summed from its rows in one snapshot.
  std::vector<Summed> sums();

private:
  std::shared_ptr<PgPool> pool_;
  const sync::SyncCatalog& catalog_;
  sync::SyncStore& store_;
};

}
