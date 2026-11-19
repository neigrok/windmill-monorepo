#include "platform/adapters/clock/SystemClock.h"
#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "platform/adapters/postgres/PgPool.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/adapters/sentry/ObservedTool.h"
#include "platform/adapters/sentry/SentryClient.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/application/sync/SyncLive.h"
#include "platform/infra/SyncProducts.h"
#include "products/roadmap/adapters/http/GalleryApi.h"
#include "products/roadmap/adapters/http/SharePageApi.h"
#include "products/roadmap/adapters/http/TreeApi.h"
#include "products/roadmap/adapters/mcp/RoadmapDoorTools.h"
#include "products/roadmap/adapters/mcp/RoadmapTools.h"
#include "products/roadmap/adapters/postgres/PgOgVideoRepository.h"
#include "products/roadmap/adapters/postgres/PgOpLog.h"
#include "products/roadmap/adapters/postgres/PgProgressRepository.h"
#include "products/roadmap/adapters/postgres/PgReminderRepository.h"
#include "products/roadmap/adapters/postgres/PgRoadmapRecords.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "products/roadmap/adapters/ws/WsPresenceBus.h"
#include "products/roadmap/adoption/Cutover.h"
#include "products/roadmap/adoption/PgAdoption.h"
#include "products/roadmap/adoption/ReadModels.h"
#include "products/roadmap/application/EngineReadModels.h"
#include "products/roadmap/application/NodeEdits.h"
#include "products/roadmap/application/OwnerProgress.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/RoadmapDoor.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TreeRegistry.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <fstream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

namespace {

using namespace wm;
using namespace wm::roadmap::adoption;

const char* configured(const char* name) {
  const char* value = std::getenv(name);
  return value && *value ? value : nullptr;
}

// The ownerless roots the move adopts under the house account: the public demo, and one id a line of the file
// ROADMAP_ADOPTION_EXPECTED_OWNERLESS names, which stays beside the private record and out of every log.
std::set<std::string> expectedOwnerless() {
  std::set<std::string> ids{kDemoRoadmap};
  const char* file = configured("ROADMAP_ADOPTION_EXPECTED_OWNERLESS");
  if (!file) return ids;
  std::ifstream in(file);
  if (!in) throw std::runtime_error("the expected ownerless roadmaps could not be read");
  for (std::string line; std::getline(in, line);) {
    line.erase(std::remove_if(line.begin(), line.end(), [](unsigned char c) { return std::isspace(c); }), line.end());
    if (!line.empty()) ids.insert(line);
  }
  return ids;
}

constexpr const char* kOrigin = "https://windmill.works";

// The old server's read models over roadmap's rooms and tables, as windmill_server builds them without
// ROADMAP_ENGINE_ENABLED.
struct OldServer {
  explicit OldServer(const std::shared_ptr<PgPool>& pool)
      : trees(std::make_shared<PgTreeRepository>(pool)), progress(std::make_shared<PgProgressRepository>(pool)),
        progressService(*progress, *trees), oplog(std::make_shared<PgOpLog>(pool)),
        rooms(std::make_shared<RoomRegistry>(*trees, *oplog, bus)),
        ownerProgress(std::make_shared<OwnerProgress>(*progress, *trees, clock)), edits(*rooms, progressService, bus, clock),
        treeRegistry(*trees, *progress, tokens, Hlc{1, 0, "genesis"}, *rooms, edits, clock),
        videos(std::make_shared<PgOgVideoRepository>(pool)),
        tools(*rooms, progressService, *ownerProgress, clock, treeRegistry, edits, kOrigin),
        treeApi(rooms, trees, ownerProgress, oplog, nullptr, nullptr, nullptr), share(rooms, trees, nullptr, videos, "", kOrigin, nullptr),
        gallery(trees, ownerProgress, nullptr, "", nullptr), reminders(pool, RoadmapEdits::trees) {}

  ReadModelSide side() {
    return ReadModelSide{tools, treeApi, share, gallery, [this](const UserId& owner) { return reminders.readinessFor(owner); }};
  }

  SystemClock clock;
  OpenSslTokenGenerator tokens;
  WsPresenceBus bus;
  std::shared_ptr<PgTreeRepository> trees;
  std::shared_ptr<PgProgressRepository> progress;
  ProgressService progressService;
  std::shared_ptr<PgOpLog> oplog;
  std::shared_ptr<RoomRegistry> rooms;
  std::shared_ptr<OwnerProgress> ownerProgress;
  NodeEdits edits;
  TreeRegistry treeRegistry;
  std::shared_ptr<PgOgVideoRepository> videos;
  RoadmapTools tools;
  TreeApi treeApi;
  SharePageApi share;
  GalleryApi gallery;
  PgReminderRepository reminders;
};

// The new server's read models over the engine's records, as windmill_server builds them with ROADMAP_ENGINE_ENABLED:
// the rooms' services beside them answer nothing a read model asks of them there.
struct NewServer {
  NewServer(const std::shared_ptr<PgPool>& pool, const sync::SyncCatalog& catalog, sync::PgSyncStore& store)
      : old(pool), records(pool), engine(std::make_shared<EngineReadModels>(records, *old.oplog, old.clock)),
        live(catalog, store, sync::Limits{}), failures(configured("SENTRY_DSN") ? configured("SENTRY_DSN") : "",
                                                       configured("SENTRY_ENVIRONMENT") ? configured("SENTRY_ENVIRONMENT") : "production"),
        door(catalog, store, live, stamps, old.clock, failures), tools(door, old.tokens, old.clock, kOrigin),
        treeApi(old.rooms, old.trees, old.ownerProgress, old.oplog, nullptr, nullptr, engine),
        share(old.rooms, old.trees, nullptr, old.videos, "", kOrigin, engine), gallery(old.trees, old.ownerProgress, nullptr, "", engine) {}

  ~NewServer() {
    door.stop();
    failures.drain();
  }

  ReadModelSide side() {
    return ReadModelSide{tools, treeApi, share, gallery, [this](const UserId& owner) { return engine->readiness(owner); }};
  }

  OldServer old;
  PgRoadmapRecords records;
  std::shared_ptr<EngineReadModels> engine;
  sync::SyncLive live;
  sync::ServerClock stamps;
  SentryClient failures;
  roadmap::RoadmapDoor door;
  RoadmapDoorTools tools;
  TreeApi treeApi;
  SharePageApi share;
  GalleryApi gallery;
};

class Servers final : public ReadModelServers {
public:
  Servers(std::shared_ptr<PgPool> pool, const sync::SyncCatalog& catalog, sync::PgSyncStore& store)
      : pool_(std::move(pool)), catalog_(catalog), store_(store) {}

  Tally settleOld(const Survey& survey) override {
    OldServer old(pool_);
    Tally counts;
    for (const auto& [id, surveyed] : survey.roadmaps()) {
      if (surveyed.deleted) continue;
      try {
        std::lock_guard<std::mutex> strand(old.rooms->strandFor(TreeId{id}));
        counts.add(old.rooms->open(TreeId{id}) ? "oldServer.opened" : "oldServer.foundNothing");
      } catch (const std::exception&) {
        counts.add("oldServer.couldNotOpen");
      }
    }
    old.rooms->stop();
    return counts;
  }

  std::vector<Json::Value> askOld(const Survey& survey) override {
    OldServer old(pool_);
    ReadModelSide side = old.side();
    std::vector<Json::Value> answers = answersOf(side, survey);
    old.rooms->stop();
    return answers;
  }

  std::vector<Json::Value> askNew(const Survey& survey) override {
    NewServer now(pool_, catalog_, store_);
    ReadModelSide side = now.side();
    return answersOf(side, survey);
  }

private:
  std::shared_ptr<PgPool> pool_;
  const sync::SyncCatalog& catalog_;
  sync::PgSyncStore& store_;
};

constexpr const char* kUsage =
    "usage: windmill_roadmap_adopt <unfold|read-models-before|before|adopt|demo|after|read-models|digests|all>, with DATABASE_URL set\n";
constexpr const char* kFailed = "A stage of the roadmap adoption failed before its end; nothing it had not committed was written.\n";

}

// Roadmap's cutover onto the sync engine (products/roadmap/adoption/README.md): one stage, or `all` of them in order,
// each printing one JSON line on stdout — its verdict, its time and its counts, nothing that names a record, an account or
// a text — and one write line on stderr. What a stage read and wrote goes only to ROADMAP_ADOPTION_PRIVATE_DIR when set.
// Exit 0 when every stage passed, 3 when one did not (the run stops there), 2 without its configuration, 1 on a failure.
int main(int argc, char** argv) {
  installToolObservability(true);
  ObservabilityLifetime lifetime;
  const std::string requested = argc == 2 ? argv[1] : "";
  const std::vector<std::string>& order = Cutover::stages();
  if (requested != "all" && std::find(order.begin(), order.end(), requested) == order.end()) {
    std::fputs(kUsage, stderr);
    return 2;
  }
  const char* url = configured("DATABASE_URL");
  if (!url) {
    std::fputs(kUsage, stderr);
    return 2;
  }
  setenv("PGCONNECT_TIMEOUT", "10", 0);
  const std::vector<std::string> stages = requested == "all" ? order : std::vector<std::string>{requested};
  const auto pool = std::make_shared<PgPool>(url, 4);
  const std::shared_ptr<sync::SyncCatalog> catalog = sync::productCatalog(sync::RoadmapServing::served);
  sync::PgSyncStore store(pool, sync::Limits{}.lockTimeoutMs);
  PgAdoption adoption(pool, *catalog, store);
  const char* privateDir = configured("ROADMAP_ADOPTION_PRIVATE_DIR");
  PrivateRecord record(privateDir ? std::optional<std::filesystem::path>(privateDir) : std::nullopt);
  Servers servers(pool, *catalog, store);
  for (const std::string& stage : stages) {
    WriteObservation observation("roadmap.adoption." + stage, "roadmap", "tool");
    try {
      Cutover cutover(adoption, Expectation{expectedOwnerless(), static_cast<sync::Ms>(SystemClock{}.nowMs())}, record, servers);
      const StageReport report = cutover.run(stage);
      std::printf("%s\n", dump(report.toJson()).c_str());
      std::fflush(stdout);
      observation.finish(report.verdict);
      if (!report.passed) return 3;
    } catch (const std::exception& error) {
      std::fputs(kFailed, stderr);
      observation.fail(error);
      return 1;
    }
  }
  return 0;
}
