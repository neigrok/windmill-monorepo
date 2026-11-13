#include "platform/adapters/json/JsonText.h"
#include "platform/adapters/postgres/PgPool.h"
#include "platform/adapters/sentry/ObservedTool.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "products/roadmap/domain/SubtreeInventory.h"

#include <cstdio>
#include <cstdlib>
#include <exception>
#include <memory>

namespace {

constexpr const char* kFailed = "The subtree inventory could not be read.\n";

// The inventory as the one JSON object the tool prints: counts, and nothing that names a tree or an account.
Json::Value countsOf(const wm::SubtreeInventory& counted) {
  const auto count = [](std::size_t value) { return Json::Value(static_cast<Json::UInt64>(value)); };
  Json::Value out(Json::objectValue);
  out["trees"] = count(counted.trees);
  out["roots"] = count(counted.roots);
  out["owned"] = count(counted.owned);
  Json::Value& multiOpened = out["multiOpened"];
  multiOpened["trees"] = count(counted.multiOpened.trees);
  multiOpened["sameTree"] = count(counted.multiOpened.sameTree);
  multiOpened["acrossTrees"] = count(counted.multiOpened.acrossTrees);
  multiOpened["maxOpeners"] = count(counted.multiOpened.maxOpeners);
  Json::Value& cycles = out["cycles"];
  cycles["trees"] = count(counted.cycles.trees);
  cycles["selfPointers"] = count(counted.cycles.selfPointers);
  cycles["loops"]["1"] = count(counted.cycles.loops.one);
  cycles["loops"]["2"] = count(counted.cycles.loops.two);
  cycles["loops"]["3-8"] = count(counted.cycles.loops.threeToEight);
  cycles["loops"]["9+"] = count(counted.cycles.loops.moreThanEight);
  Json::Value& dangling = out["dangling"];
  dangling["missing"] = count(counted.dangling.missing);
  dangling["deleted"] = count(counted.dangling.deleted);
  dangling["foreign"] = count(counted.dangling.foreign);
  dangling["notATreeId"] = count(counted.dangling.notATreeId);
  Json::Value& depth = out["depth"];
  depth["deepest"] = count(counted.depth.deepest);
  depth["1"] = count(counted.depth.one);
  depth["2"] = count(counted.depth.two);
  depth["3"] = count(counted.depth.three);
  depth["4+"] = count(counted.depth.moreThanThree);
  out["accounts"]["withPointers"] = count(counted.accounts.withPointers);
  out["accounts"]["needingChoice"] = count(counted.accounts.needingChoice);
  return out;
}

}

// Counts how the pointers between the roadmap's trees meet one owned subtree per step (SPEC.md, Subtree inventory) and
// prints them as one JSON object on stdout, nothing else. It never writes. A failure prints one fixed sentence on stderr
// and exits 2 without DATABASE_URL, 1 otherwise.
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
    std::printf("%s\n", dump(countsOf(counted)).c_str());
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
