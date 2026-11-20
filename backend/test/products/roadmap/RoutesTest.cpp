#include "products/roadmap/routes.h"

#include "platform/adapters/http/WriteRoutes.h"
#include "platform/application/OAuthService.h"
#include "products/roadmap/adapters/ws/Collab.h"
#include "test/platform/Fakes.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <cstddef>
#include <memory>
#include <set>
#include <string>
#include <tuple>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

// A route as one registration of roadmap's declares it: its method, its path, how it is served (`write`, `read`, or
// `retired`, which answers 410 `client-update-required` before authentication) and the static operation its lines carry.
using Declared = std::tuple<std::string, std::string, std::string, std::string>;

// What one registration of roadmap's routes declared, and the controller that then takes an upgrade of /v1/socket.
struct Mounted {
  std::set<Declared> routes;
  std::set<std::string> socket;
};

// Registers roadmap's routes on this process's one app, as main.cpp does, and reads back what that registration
// declared: the routes declared after it began, and the WebSocket controller bound to the socket's path once it ends.
Mounted mount(const RoadmapDeps& deps) {
  const std::size_t writesBefore = registeredWriteRoutes().size();
  const std::size_t readsBefore = registeredReadRoutes().size();
  registerRoutes(drogon::app(), deps);
  Mounted mounted;
  const std::vector<WriteRoute> writes = registeredWriteRoutes();
  for (std::size_t at = writesBefore; at < writes.size(); ++at)
    for (const auto method : writes[at].methods)
      mounted.routes.emplace(std::string(drogon::to_string_view(method)), writes[at].path, writes[at].retired ? "retired" : "write",
                             writes[at].operation);
  const std::vector<WriteRoute> reads = registeredReadRoutes();
  for (std::size_t at = readsBefore; at < reads.size(); ++at)
    for (const auto method : reads[at].methods)
      mounted.routes.emplace(std::string(drogon::to_string_view(method)), reads[at].path, "read", reads[at].operation);
  for (const auto& [path, method, description] : drogon::app().getHandlersInfo())
    if (path == "/v1/socket" && description.rfind("WebsocketController: ", 0) == 0) mounted.socket.insert(description);
  return mounted;
}

}

TEST(roadmap_routes_where_the_rooms_serve_mount_every_room_route_and_the_collab_socket_as_before_the_move) {
  // Drogon keeps every handler a registration makes until the process ends, so what it is handed shares one lifetime.
  struct Rooms {
    FakeProgressRepository progressRepo;
    FakeTreeRepository trees{progressRepo};
    FakeOpLog ops;
    WsPresenceBus bus;
    HeldRetries retries;
    RoomRegistry registry{trees, ops, bus, retries.timer()};
    ProgressService progress{progressRepo, trees};
    FakeAuthRepository authRepo;
    FakeEmail email;
    FakeTokens tokens;
    FakeClock clock;
    FakeOAuthRepository oauthRepo;
    OAuthService oauth{oauthRepo, tokens, clock};
    FakeAccountFootprint footprint;
    FakeSessionRevocations revocations;
    AuthService auth{authRepo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works"};
    PresenceHub presence{bus};
  };
  const auto rooms = std::make_shared<Rooms>();
  const Mounted mounted = mount(RoadmapDeps{.registry = std::shared_ptr<RoomRegistry>(rooms, &rooms->registry),
                                            .trees = std::shared_ptr<TreeRepository>(rooms, &rooms->trees),
                                            .progressService = std::shared_ptr<ProgressService>(rooms, &rooms->progress),
                                            .oplog = std::shared_ptr<OpLog>(rooms, &rooms->ops),
                                            .bus = std::shared_ptr<WsPresenceBus>(rooms, &rooms->bus),
                                            .presence = std::shared_ptr<PresenceHub>(rooms, &rooms->presence),
                                            .authService = std::shared_ptr<AuthService>(rooms, &rooms->auth),
                                            .clock = std::shared_ptr<Clock>(rooms, &rooms->clock)});
  setCollab(nullptr);

  CHECK_EQ(mounted.routes, (std::set<Declared>{
      {"POST", "/v1/trees", "write", "roadmap.POST.v1.trees"},
      {"GET", "/v1/trees", "read", "roadmap.GET.v1.trees"},
      {"GET", "/v1/trees/{id}", "read", "roadmap.GET.v1.trees.id"},
      {"PATCH", "/v1/trees/{id}", "write", "roadmap.PATCH.v1.trees.id"},
      {"DELETE", "/v1/trees/{id}", "write", "roadmap.DELETE.v1.trees.id"},
      {"PUT", "/v1/trees/{tree}/steps/{step}/subtree", "write", "roadmap.PUT.v1.trees.tree.steps.step.subtree"},
      {"GET", "/v1/trees/{id}/guides", "read", "roadmap.GET.v1.trees.id.guides"},
      {"GET", "/v1/trees/{id}/diagnostics", "read", "roadmap.GET.v1.trees.id.diagnostics"},
      {"POST", "/v1/trees/{id}/fork", "write", "roadmap.POST.v1.trees.id.fork"},
      {"GET", "/v1/trees/{id}/progress", "read", "roadmap.GET.v1.trees.id.progress"},
      {"GET", "/v1/trees/{id}/activity", "read", "roadmap.GET.v1.trees.id.activity"},
      {"PUT", "/v1/trees/{id}/og-image", "write", "roadmap.PUT.v1.trees.id.og.image"},
      {"PUT", "/v1/trees/{id}/og-video", "write", "roadmap.PUT.v1.trees.id.og.video"},
      {"GET", "/v1/trees/{id}/og-video", "read", "roadmap.GET.v1.trees.id.og.video"},
      {"POST", "/v1/trees/{id}/tend", "write", "roadmap.POST.v1.trees.id.tend"},
      {"GET", "/v1/tend/{runId}", "read", "roadmap.GET.v1.tend.runid"},
      {"GET", "/v1/tending", "read", "roadmap.GET.v1.tending"},
      {"GET", "/v1/reminders", "read", "roadmap.GET.v1.reminders"},
      {"PATCH", "/v1/reminders", "write", "roadmap.PATCH.v1.reminders"},
      {"POST", "/v1/reminders/pause", "write", "roadmap.POST.v1.reminders.pause"},
      {"POST", "/v1/reminders/unsubscribe", "write", "roadmap.POST.v1.reminders.unsubscribe"},
      {"POST", "/v1/admin/reminders/sweep", "write", "roadmap.POST.v1.admin.reminders.sweep"},
      {"GET", "/t/{id}", "read", "roadmap.GET.t.id"},
      {"GET", "/gallery", "read", "roadmap.GET.gallery"},
      {"GET", "/v1/gallery", "read", "roadmap.GET.v1.gallery"},
      {"GET", "/og/{id}.png", "read", "roadmap.GET.og.id.png"},
      {"POST", "/v1/compose", "write", "roadmap.POST.v1.compose"}}));
  CHECK_EQ(mounted.socket, (std::set<std::string>{"WebsocketController: wm::TreeSocket"}));
}

TEST(roadmap_routes_where_the_engine_serves_roadmap_retire_every_room_route_and_the_socket_and_keep_the_rest) {
  // Drogon keeps every handler a registration makes until the process ends, so what it is handed shares one lifetime.
  struct Engine {
    struct NoRecords final : RoadmapRecords {
      std::optional<UserId> ownerOf(const TreeId&) override { return std::nullopt; }
      AccountRoadmaps roadmapsOf(const UserId&, const std::optional<std::set<TreeId>>&, std::optional<std::chrono::milliseconds>) override {
        return {};
      }
      std::vector<ListedRoot> publicRoots() override { return {}; }
      ForkLineage lineageOf(const TreeId&) override { return {}; }
      std::set<TreeId> forkedSources(const UserId&) override { return {}; }
    };
    NoRecords records;
    FakeOpLog activity;
    FakeClock clock;
    EngineReadModels reads{records, activity, clock};
  };
  const auto engine = std::make_shared<Engine>();
  const Mounted mounted = mount(RoadmapDeps{.engineReads = std::shared_ptr<EngineReadModels>(engine, &engine->reads)});

  CHECK_EQ(mounted.routes, (std::set<Declared>{
      {"POST", "/v1/trees", "retired", "roadmap.POST.v1.trees"},
      {"GET", "/v1/trees", "retired", "roadmap.GET.v1.trees"},
      {"GET", "/v1/trees/{id}", "retired", "roadmap.GET.v1.trees.id"},
      {"PATCH", "/v1/trees/{id}", "retired", "roadmap.PATCH.v1.trees.id"},
      {"DELETE", "/v1/trees/{id}", "retired", "roadmap.DELETE.v1.trees.id"},
      {"PUT", "/v1/trees/{tree}/steps/{step}/subtree", "retired", "roadmap.PUT.v1.trees.tree.steps.step.subtree"},
      {"GET", "/v1/trees/{id}/guides", "retired", "roadmap.GET.v1.trees.id.guides"},
      {"GET", "/v1/trees/{id}/diagnostics", "retired", "roadmap.GET.v1.trees.id.diagnostics"},
      {"GET", "/v1/socket", "retired", "roadmap.GET.v1.socket"},
      {"POST", "/v1/trees/{id}/fork", "write", "roadmap.POST.v1.trees.id.fork"},
      {"GET", "/v1/trees/{id}/progress", "read", "roadmap.GET.v1.trees.id.progress"},
      {"GET", "/v1/trees/{id}/activity", "read", "roadmap.GET.v1.trees.id.activity"},
      {"PUT", "/v1/trees/{id}/og-image", "write", "roadmap.PUT.v1.trees.id.og.image"},
      {"PUT", "/v1/trees/{id}/og-video", "write", "roadmap.PUT.v1.trees.id.og.video"},
      {"GET", "/v1/trees/{id}/og-video", "read", "roadmap.GET.v1.trees.id.og.video"},
      {"POST", "/v1/trees/{id}/tend", "write", "roadmap.POST.v1.trees.id.tend"},
      {"GET", "/v1/tend/{runId}", "read", "roadmap.GET.v1.tend.runid"},
      {"GET", "/v1/tending", "read", "roadmap.GET.v1.tending"},
      {"GET", "/v1/reminders", "read", "roadmap.GET.v1.reminders"},
      {"PATCH", "/v1/reminders", "write", "roadmap.PATCH.v1.reminders"},
      {"POST", "/v1/reminders/pause", "write", "roadmap.POST.v1.reminders.pause"},
      {"POST", "/v1/reminders/unsubscribe", "write", "roadmap.POST.v1.reminders.unsubscribe"},
      {"POST", "/v1/admin/reminders/sweep", "write", "roadmap.POST.v1.admin.reminders.sweep"},
      {"GET", "/t/{id}", "read", "roadmap.GET.t.id"},
      {"GET", "/gallery", "read", "roadmap.GET.gallery"},
      {"GET", "/v1/gallery", "read", "roadmap.GET.v1.gallery"},
      {"GET", "/og/{id}.png", "read", "roadmap.GET.og.id.png"},
      {"POST", "/v1/compose", "write", "roadmap.POST.v1.compose"}}));
  CHECK_EQ(mounted.socket, (std::set<std::string>{"WebsocketController: wm::RetiredSocket"}));
}
