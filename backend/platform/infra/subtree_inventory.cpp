#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgPool.h"
#include "platform/adapters/sentry/ObservedTool.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "products/roadmap/domain/SubtreeInventory.h"

#include <cstdio>
#include <cstdlib>
#include <exception>
#include <memory>
#include <stdexcept>

namespace {

constexpr const char* kFailed = "The subtree inventory could not be read.\n";
constexpr const char* kNotTaken = "The subtree inventory was counted, and stdout did not take the counts.\n";

// The inventory as the one JSON object the tool prints: counts, and nothing that names a tree or an account.
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

}

// Counts how the pointers between the roadmap's trees meet one owned subtree per step (SPEC.md, Subtree inventory) and
// prints them as one JSON object on stdout, nothing else. It never writes. A failure prints one fixed sentence on stderr
// and exits 2 without DATABASE_URL, 1 when the read fails or stdout does not take the counts.
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
    PgTreeRepository trees{std::make_shared<PgPool>(url, 1)};
    SubtreeInventory counted;
    trees.eachAccountsTrees([&counted](const UserId&, const AccountTrees& account) { counted += inventory(account); });
    if (std::printf("%s\n", dump(countsOf(counted)).c_str()) < 0 || std::fflush(stdout) != 0) {
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
