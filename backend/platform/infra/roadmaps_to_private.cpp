#include "platform/adapters/clock/SystemClock.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgPool.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/adapters/sentry/ObservedTool.h"
#include "platform/infra/SyncProducts.h"
#include "products/roadmap/application/RoadmapDoor.h"
#include "products/roadmap/application/RoadmapRows.h"
#include "products/roadmap/domain/Access.h"

#include <pqxx/pqxx>

#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr const char* kUsage = "usage: windmill_roadmaps_to_private [--write], with DATABASE_URL set\n";
constexpr const char* kFailed =
    "The move of unlisted roadmaps to private stopped before its end: what it moved stays private, and a run again "
    "moves the rest.\n";
constexpr const char* kNotTaken =
    "The move of unlisted roadmaps to private ran to its end, and stdout did not take its counts.\n";
constexpr const char* kHouseRoadmap = "house-roadmap";

// Every alive roadmap that reads as unlisted, with whose it is and where it sits: a root by the visibility its meta
// holds, a subtree by its reach, since only a root holds a visibility, as the subtree inventory counts them.
constexpr const char* kUnlisted = R"(
select t.id, s.owner::text, coalesce(jsonb_typeof(t.parent) = 'object', false)
from roadmap_trees t
join sync_scopes s on s.key = t.scope_key
join roadmap_metas m on m.scope_key = 'tree:' || t.id and m.id = 'meta'
where t.life = 'alive'
  and case when jsonb_typeof(t.parent) = 'object' then m.reach else m.visibility end = 'unlisted'
order by t.id)";

// An alive roadmap the engine's tables hold as unlisted.
struct Unlisted {
  std::string tree;
  wm::UserId owner;
  bool subtree = false;

  bool house() const { return owner == wm::kHouseAccount; }
};

// The unlisted roadmaps of one snapshot. A hand-run read of whole tables, so its statement may run a minute rather than
// the pool's 5 s, and fails closed past it.
std::vector<Unlisted> unlistedIn(wm::PgPool& pool) {
  wm::PgLease conn{pool};
  pqxx::transaction<pqxx::isolation_level::repeatable_read, pqxx::write_policy::read_only> txn{*conn};
  txn.exec("SET LOCAL statement_timeout = '60s'");
  std::vector<Unlisted> unlisted;
  for (const auto& row : txn.exec(kUnlisted))
    unlisted.push_back(Unlisted{row[0].as<std::string>(), wm::UserId{row[1].as<std::string>()}, row[2].as<bool>()});
  return unlisted;
}

// The unlisted roadmaps as counts, the house's apart from people's and roots apart from subtrees: nothing that names a
// roadmap or an account.
Json::Value countsOf(const std::vector<Unlisted>& unlisted) {
  Json::Value out(Json::objectValue);
  for (const char* account : {"people", "house"})
    for (const char* place : {"roots", "subtrees"}) out[account][place] = Json::UInt64(0);
  for (const Unlisted& roadmap : unlisted) {
    Json::Value& bucket = out[roadmap.house() ? "house" : "people"][roadmap.subtree ? "subtrees" : "roots"];
    bucket = Json::UInt64(bucket.asUInt64() + 1);
  }
  return out;
}

// What the run did with the unlisted roots it read: people's it set out to move, what each came to, and what it refused,
// the house's by `house-roadmap` and any other by the engine's code.
struct Moves {
  std::size_t toMove = 0;
  std::size_t moved = 0;
  std::size_t unchanged = 0;
  std::map<std::string, std::size_t> refused{{kHouseRoadmap, 0}};

  void count(const std::string& outcome) {
    if (outcome == "moved") ++moved;
    else if (outcome == "unchanged") ++unchanged;
    else ++refused[outcome];
  }

  std::size_t refusals() const {
    std::size_t all = 0;
    for (const auto& [code, count] : refused) all += count;
    return all;
  }

  Json::Value json() const {
    Json::Value out(Json::objectValue);
    out["toMove"] = Json::UInt64(toMove);
    out["moved"] = Json::UInt64(moved);
    out["unchanged"] = Json::UInt64(unchanged);
    out["refused"] = Json::Value(Json::objectValue);
    for (const auto& [code, count] : refused) out["refused"][code] = Json::UInt64(count);
    return out;
  }
};

// One people's root made private by its owner's server-origin intent through roadmap's door (engine.md §6.3): admission
// mints the stamps, and the binding writes the root's reach and the reach of every subtree under it (Appendix A.1,
// Visibility), so every replica pulls the change. Under the scope's lock a root that no longer reads unlisted, since its
// owner chose again, is left as its owner left it: `unchanged`. An engine refusal answers its code.
std::string moveToPrivate(wm::roadmap::RoadmapDoor& door, const Unlisted& root) {
  bool built = false;
  const wm::roadmap::RoadmapDoor::Build privateWhileUnlisted = [&](wm::sync::SyncTxn& txn) -> std::optional<Json::Value> {
    built = false;
    if (door.rows().tree(txn, root.tree, std::nullopt).metaText("visibility") != "unlisted") return std::nullopt;
    built = true;
    Json::Value fields(Json::objectValue);
    fields["visibility"] = "private";
    Json::Value deltas(Json::arrayValue);
    deltas.append(wm::roadmap::Written{.type = "meta", .id = Json::Value("meta"), .fields = fields}.json());
    return wm::roadmap::intentIn("tree/" + root.tree, deltas);
  };
  Json::Value args(Json::objectValue);
  args["tree"] = root.tree;
  const Json::Value landed = door.run(root.owner, std::nullopt, "ops.roadmaps_to_private", args, [&](auto& call) {
    return call.admitBuilt(wm::roadmap::treePlaceholder(root.tree), privateWhileUnlisted);
  });
  if (!wm::roadmap::landed(landed)) return wm::roadmap::refusalOf(landed);
  return built ? "moved" : "unchanged";
}

// One root the run writes, its own write line at the tool's door: `moved`, `unchanged`, or the refusal that wrote
// nothing, `house-roadmap` for a house account's, which answers links and sign-up forks and is nobody's to move here.
std::string moveOne(wm::roadmap::RoadmapDoor& door, const Unlisted& root) {
  wm::WriteObservation observation("roadmap.unlisted.move", "roadmap", "tool", wm::freshWriteRequestId());
  wm::WriteContext context(observation);
  if (root.house()) {
    observation.finish(kHouseRoadmap);
    return kHouseRoadmap;
  }
  try {
    const std::string outcome = moveToPrivate(door, root);
    if (outcome == "moved") observation.succeed(outcome);
    else observation.finish(outcome);
    return outcome;
  } catch (const std::exception& error) {
    observation.fail(error);
    throw;
  } catch (...) {
    observation.failUnknown();
    throw;
  }
}

}

// Moves every unlisted roadmap of the engine's to private, people's alone (SPEC.md, Unlisted roadmaps to private): a dry
// run by default, writing only with --write. It prints one JSON object on stdout — the unlisted roadmaps counted before
// and after, and what came of each root — and nothing that names a roadmap, an account or a text. A failure prints one
// fixed sentence on stderr and exits 2 for its usage or without DATABASE_URL, 1 when a read or a write fails or stdout
// does not take the counts.
int main(int argc, char** argv) {
  using namespace wm;
  installToolObservability(true);
  ObservabilityLifetime lifetime;
  WriteObservation run("roadmap.unlisted.to_private", "roadmap", "tool");
  if (argc > 2 || (argc == 2 && std::string(argv[1]) != "--write")) {
    std::fputs(kUsage, stderr);
    run.finish("usage");
    return 2;
  }
  const bool write = argc == 2;
  try {
    const char* url = std::getenv("DATABASE_URL");
    if (!url || !*url) {
      std::fputs(kUsage, stderr);
      run.finish("configuration-unavailable");
      return 2;
    }
    setenv("PGCONNECT_TIMEOUT", "10", 0);
    const std::shared_ptr<PgPool> pool = std::make_shared<PgPool>(url, 2);
    const std::shared_ptr<sync::SyncCatalog> catalog = sync::productCatalog(sync::roadmapServing());
    sync::PgSyncStore store(pool, sync::Limits{}.lockTimeoutMs);
    sync::NullChangeFeed feed;
    sync::ServerClock stamps;
    SystemClock clock;
    roadmap::RoadmapDoor door(*catalog, store, feed, stamps, clock, toolFailureReporter());

    const std::vector<Unlisted> before = unlistedIn(*pool);
    Moves moves;
    // A subtree follows its root's visibility, so only roots are written.
    for (const Unlisted& root : before) {
      if (root.subtree) continue;
      if (!root.house()) ++moves.toMove;
      if (write) moves.count(moveOne(door, root));
      else if (root.house()) moves.count(kHouseRoadmap);
    }
    Json::Value counts(Json::objectValue);
    counts["write"] = write;
    counts["unlisted"]["before"] = countsOf(before);
    counts["unlisted"]["after"] = countsOf(unlistedIn(*pool));
    counts["roots"] = moves.json();
    if (std::printf("%s\n", dump(counts).c_str()) < 0 || std::fflush(stdout) != 0) {
      std::fputs(kNotTaken, stderr);
      run.fail(std::runtime_error("stdout did not take the counts"));
      return 1;
    }
    run.countRefused(moves.refusals());
    if (!write) run.succeed("dry-run");
    else if (moves.moved) run.succeed("moved");
    else run.finish("unchanged");
    return 0;
  } catch (const std::exception& error) {
    std::fputs(kFailed, stderr);
    run.fail(error);
    return 1;
  } catch (...) {
    std::fputs(kFailed, stderr);
    run.failUnknown();
    return 1;
  }
}
