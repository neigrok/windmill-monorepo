#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "platform/application/sync/SyncCatalog.h"
#include "platform/ports/SyncStore.h"
#include "products/roadmap/adoption/Adoption.h"
#include "products/roadmap/adoption/Audit.h"

#include <cstdint>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

// The adoption on Postgres: roadmap's own tables read whole, one owner's plan written into the engine's tables through
// the binding's stores, the engine's tables read back through the binding, and every scope's digest summed from its rows.

namespace wm::roadmap::adoption {

// Why writing one owner's roadmaps stopped short, writing nothing of that owner's: a static code, the roadmap it was at
// (none before it reached one), and whether the move must stop there for its operator to look, or failed.
struct AdoptionFailure : std::runtime_error {
  AdoptionFailure(std::string code, std::string roadmap, bool stops);

  std::string code;
  std::string roadmap;
  bool stops = false;
};

// What writing one owner's plan did: the roadmaps it adopted, and those whose `tree` record it found already there.
struct Written {
  std::size_t adopted = 0;
  std::size_t already = 0;
};

// One alive scope's §6.12 sum against the digest its row holds, whether its seq stands at or past every row's, and, for a
// tree, whether its `open` says what its opening field does: strangers read it exactly while its reach opens it.
struct Summed {
  sync::ScopeKey key;
  bool digestHolds = false;
  bool seqHolds = false;
  bool openHolds = true;
};

// Every roadmap the old server reads, through its own repositories, and the ids of those it cannot read: it throws on a
// stamp it cannot parse.
struct OldReadings {
  std::vector<OldReading> readings;
  std::set<std::string> unreadable;
};

class PgAdoption {
public:
  // `ownSessions` is the application name of every session this run opens, which counts no session of its own as
  // another client's.
  PgAdoption(std::shared_ptr<PgPool> pool, const sync::SyncCatalog& catalog, sync::SyncStore& store, std::string ownSessions);

  // Every roadmap of roadmap's own tables, a roadmap stored only as a whole document unfolded into rows as the old server
  // unfolds it, its links as the old server reads them; and every account.
  OldDatabase oldTables();

  // When each roadmap last changed (`trees.updated_at`, as its text), and that time put back on every roadmap whose row
  // now says another, answering how many it put back: the old server's opening of a roadmap moves it to the time of
  // opening, which would become the roadmap's record's, its gallery card's and its reminders' last change.
  std::map<std::string, std::string> lastChanges();
  std::size_t keepLastChanges(const std::map<std::string, std::string>& changed);

  // The old server's reading of every roadmap the survey holds, deleted ones answering none as the old server's do.
  OldReadings oldReadings(const Survey& survey);

  // The roadmaps the plan would create a scope of that the engine already holds, while their `tree` record is absent:
  // the move cannot create them, and stops.
  std::vector<std::string> scopesInTheWay(const Plan& plan);

  // The house account, inserted when absent; false when its address names another account, which stops the move.
  bool houseStands();

  // How many client sessions other than this run's are connected to the database: the move runs with none, so no writer
  // changes roadmap's tables under it.
  std::uint64_t otherSessions();

  // One transaction: under the move's lock, roadmap's own tables held in SHARE mode, and the owner's account held, the
  // owner's rows are read again and each of the owner's roadmaps whose `tree` record no row holds is written, its record
  // into the owner's roadmap scope at that scope's next seqs, its tree scope and its overlays as the plan has them. A
  // roadmap whose record is there is left as it is, so a second run writes nothing. Throws AdoptionFailure, writing
  // nothing: a stop when the owner's account is gone, their rows differ from those the plan was made from, or a scope
  // the plan creates is already there; a failure when the store refuses a row or the commit.
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
  std::string ownSessions_;
};

}
