#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgPool.h"
#include "platform/adapters/sentry/ObservedTool.h"
#include "platform/domain/sync/Scope.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/SubtreeInventory.h"

#include <pqxx/pqxx>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <memory>
#include <stdexcept>
#include <string>

namespace {

constexpr const char* kFailed = "The subtree inventory could not be read.\n";
constexpr const char* kNotTaken = "The subtree inventory was counted, and stdout did not take the counts.\n";

// The subtree inventory as JSON: counts, and nothing that names a tree or an account.
Json::Value countsOf(const wm::SubtreeInventory& counted) {
  const auto count = [](std::size_t value) { return Json::Value(static_cast<Json::UInt64>(value)); };
  const auto depthOf = [&count](const wm::SubtreeInventory::Depth& depth) {
    Json::Value out(Json::objectValue);
    out["deepest"] = count(depth.deepest);
    out["1"] = count(depth.one);
    out["2"] = count(depth.two);
    out["3"] = count(depth.three);
    out["4+"] = count(depth.moreThanThree);
    return out;
  };
  Json::Value out(Json::objectValue);
  out["trees"] = count(counted.trees);
  out["roots"] = count(counted.roots);
  out["owned"] = count(counted.owned);
  out["hanging"] = count(counted.hanging);
  Json::Value& multiOpened = out["multiOpened"];
  multiOpened["trees"] = count(counted.multiOpened.trees);
  multiOpened["sameTree"] = count(counted.multiOpened.sameTree);
  multiOpened["acrossTrees"] = count(counted.multiOpened.acrossTrees);
  multiOpened["maxOpeners"] = count(counted.multiOpened.maxOpeners);
  Json::Value& cycles = out["cycles"];
  cycles["trees"] = count(counted.cycles.trees);
  cycles["selfPointers"] = count(counted.cycles.selfPointers);
  cycles["alsoMultiOpened"] = count(counted.cycles.alsoMultiOpened);
  cycles["loops"]["1"] = count(counted.cycles.loops.one);
  cycles["loops"]["2"] = count(counted.cycles.loops.two);
  cycles["loops"]["3-8"] = count(counted.cycles.loops.threeToEight);
  cycles["loops"]["9+"] = count(counted.cycles.loops.moreThanEight);
  cycles["byEntries"]["0"] = count(counted.cycles.byEntries.none);
  cycles["byEntries"]["1"] = count(counted.cycles.byEntries.one);
  cycles["byEntries"]["2+"] = count(counted.cycles.byEntries.twoOrMore);
  Json::Value& dangling = out["dangling"];
  dangling["missing"] = count(counted.dangling.missing);
  dangling["deleted"] = count(counted.dangling.deleted);
  dangling["foreign"] = count(counted.dangling.foreign);
  dangling["notATreeId"] = count(counted.dangling.notATreeId);
  out["depth"] = depthOf(counted.depth);
  out["depthIfResolved"] = depthOf(counted.depthIfResolved);
  out["accounts"]["withPointers"] = count(counted.accounts.withPointers);
  out["accounts"]["needingChoice"] = count(counted.accounts.needingChoice);
  return out;
}

// Every alive roadmap once, by whose it is and the visibility it reads as. The house's ($1 its product scope) are apart
// from people's. A root reads as the visibility its meta holds, a subtree as its reach, since only a root holds a
// visibility. A roadmap with no meta, or a meta that holds none, is unset.
constexpr const char* kRoadmapsByVisibility = R"(
select account, place,
       case when held is null then 'unset' when held in ('private', 'public') then held else 'other' end,
       count(*)
from (select case when t.scope_key = $1 then 'house' else 'people' end as account,
             case when jsonb_typeof(t.parent) = 'object' then 'subtrees' else 'roots' end as place,
             case when jsonb_typeof(t.parent) = 'object' then m.reach else m.visibility end as held
      from roadmap_trees t
      left join roadmap_metas m on m.scope_key = 'tree:' || t.id and m.id = 'meta'
      where t.life = 'alive') roadmaps
group by 1, 2, 3)";

// The pointers alive with no `opens` in an alive roadmap's overlay, by the door their life stamp's actor names: the
// server's `srv`, an Undo's restore, or any other, a client's put.
constexpr const char* kPointersWithoutOpensByDoor = R"(
select case when p.life_stamp ~ '^[0-9]+:[0-9]+:srv$' then 'restore' else 'clientPut' end, count(*)
from roadmap_pointers p
join sync_scopes s on s.key = p.scope_key and s.state = 'alive'
where p.life = 'alive' and p.opens is null
group by 1)";

// The counts of the sync engine's roadmap tables, read from one snapshot. A hand-run read of whole tables, so each
// statement may run a minute rather than the pool's 5 s, and fails closed past it. Every bucket starts at zero here, so
// each prints, and the statements name no other.
Json::Value engineCountsOf(wm::PgPool& pool) {
  Json::Value out(Json::objectValue);
  for (const char* account : {"house", "people"})
    for (const char* place : {"roots", "subtrees"})
      for (const char* held : {"private", "public", "unset", "other"})
        out["visibility"][account][place][held] = Json::UInt64(0);
  for (const char* door : {"restore", "clientPut"}) out["pointersWithoutOpens"][door] = Json::UInt64(0);
  wm::PgLease conn{pool};
  pqxx::transaction<pqxx::isolation_level::repeatable_read, pqxx::write_policy::read_only> txn{*conn};
  txn.exec("SET LOCAL statement_timeout = '60s'");
  const pqxx::params house{wm::sync::ScopeKey::product(wm::kHouseAccount, "roadmap").text()};
  for (const auto& row : txn.exec(kRoadmapsByVisibility, house))
    out["visibility"][row[0].as<std::string>()][row[1].as<std::string>()][row[2].as<std::string>()] =
        Json::UInt64(row[3].as<std::uint64_t>());
  for (const auto& row : txn.exec(kPointersWithoutOpensByDoor))
    out["pointersWithoutOpens"][row[0].as<std::string>()] = Json::UInt64(row[1].as<std::uint64_t>());
  return out;
}

}

// Counts how the pointers between the roadmap's trees meet one owned subtree per step, and the engine's roadmaps by
// visibility and pointers alive with no `opens` (SPEC.md, Subtree inventory). It prints them as one JSON object on
// stdout, nothing else, and never writes. A failure prints one fixed sentence on stderr and exits 2 without
// DATABASE_URL, 1 when the read fails or stdout does not take the counts.
int main() {
  using namespace wm;
  installToolObservability(true);
  ObservabilityLifetime lifetime;
  WriteObservation observation("roadmap.subtree.inventory", "roadmap", "tool");
  try {
    const char* url = std::getenv("DATABASE_URL");
    if (!url || !*url) {
      std::fputs("The subtree inventory needs DATABASE_URL.\n", stderr);
      observation.finish("configuration-unavailable");
      return 2;
    }
    setenv("PGCONNECT_TIMEOUT", "10", 0);
    const std::shared_ptr<PgPool> pool = std::make_shared<PgPool>(url, 1);
    PgTreeRepository trees{pool};
    SubtreeInventory counted;
    trees.eachAccountsTrees([&counted](const UserId&, const AccountTrees& account) { counted += inventory(account); });
    Json::Value counts = countsOf(counted);
    counts["engine"] = engineCountsOf(*pool);
    if (std::printf("%s\n", dump(counts).c_str()) < 0 || std::fflush(stdout) != 0) {
      std::fputs(kNotTaken, stderr);
      observation.fail(std::runtime_error("stdout did not take the counts"));
      return 1;
    }
    observation.finish();
    return 0;
  } catch (const std::exception& error) {
    std::fputs(kFailed, stderr);
    observation.fail(error);
    return 1;
  } catch (...) {
    std::fputs(kFailed, stderr);
    observation.failUnknown();
    return 1;
  }
}
