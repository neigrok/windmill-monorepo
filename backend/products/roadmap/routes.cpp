#include "products/roadmap/routes.h"

#include "products/roadmap/adapters/http/ComposeApi.h"
#include "products/roadmap/adapters/http/GalleryApi.h"
#include "products/roadmap/adapters/http/HttpApi.h"
#include "products/roadmap/adapters/http/OgImageApi.h"
#include "products/roadmap/adapters/http/OgVideoApi.h"
#include "products/roadmap/adapters/http/RemindersApi.h"
#include "products/roadmap/adapters/http/SharePageApi.h"
#include "products/roadmap/adapters/http/TendingApi.h"
#include "products/roadmap/adapters/http/TreeRegistryApi.h"
#include "products/roadmap/adapters/ws/Collab.h"
#include "products/roadmap/adapters/ws/TreeSocket.h"

#include <drogon/drogon.h>

#include <memory>
#include <string>
#include <utility>

namespace wm {

// The roadmap product's whole HTTP/WS surface, mounted behind one named seam. main.cpp builds the
// platform + roadmap singletons and the shared MCP endpoint, bundles the roadmap collaborators into
// RoadmapDeps, and calls this. A future product mirrors the same shape: its own registerRoutes over
// its own deps. Behaviour is identical to the flat router this was lifted out of — same handlers,
// same paths, same order relative to one another.
void registerRoutes(drogon::HttpAppFramework& app, const RoadmapDeps& deps) {
  // The socket authenticates each connection at its upgrade and writes progress as that
  // user; anonymous connections may view but not edit.
  setCollab(std::make_shared<Collab>(*deps.registry, *deps.oplog, *deps.bus, *deps.progressService,
                                     *deps.authService, *deps.presence, *deps.clock));
  linkTreeSocket();

  auto api = std::make_shared<HttpApi>(deps.registry, deps.trees, deps.progress, deps.oplog,
                                       deps.genesis, deps.authService, deps.forkService);
  auto ogImageApi = std::make_shared<OgImageApi>(deps.ogImages, deps.trees, deps.authService);
  auto ogVideoApi = std::make_shared<OgVideoApi>(deps.ogVideos, deps.trees, deps.authService);
  auto sharePageApi =
      std::make_shared<SharePageApi>(deps.registry, deps.trees, deps.authService, deps.ogVideos, deps.webRoot);
  auto galleryApi = std::make_shared<GalleryApi>(deps.trees, deps.progress, deps.authService, deps.webRoot);
  auto registryApi = std::make_shared<TreeRegistryApi>(deps.treeRegistry, deps.authService);
  auto tendingApi = std::make_shared<TendingApi>(deps.tendingService, deps.authService);
  auto remindersApi = std::make_shared<RemindersApi>(deps.reminderSweep, deps.reminderRepo, deps.authService,
                                                     deps.tokens, deps.clock, deps.remindersAdminToken);
  auto composeApi = std::make_shared<ComposeApi>(deps.composer);

  // Presence coalescing: flush buffered cursors/selections to subscribers at 20 Hz (§12),
  // once the event loop is up. One timer drains every tree, latest-wins per actor.
  auto presence = deps.presence;
  app.registerBeginningAdvice([presence]() {
    drogon::app().getLoop()->runEvery(0.05, [presence]() { presence->flush(); });
  });

  app.registerHandler(
      "/v1/trees",
      [registryApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        registryApi->createTree(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/trees",
      [registryApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        registryApi->listTrees(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/trees/{id}",
      [registryApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        registryApi->patchTree(req, std::move(cb), id);
      },
      {drogon::Patch});
  app.registerHandler(
      "/v1/trees/{id}",
      [registryApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        registryApi->deleteTree(req, std::move(cb), id);
      },
      {drogon::Delete});
  app.registerHandler(
      "/v1/trees/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getTree(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/trees/{id}",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->putTree(req, std::move(cb), id);
      },
      {drogon::Put});
  app.registerHandler(
      "/v1/trees/{id}/fork",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->forkTree(req, std::move(cb), id);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/trees/{id}/progress",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getProgress(req, std::move(cb), id);
      },
      {drogon::Get});

  // Per-tree unfurl card upload (og-tree-cards): owner-only, the raw PNG in the body.
  app.registerHandler(
      "/v1/trees/{id}/og-image",
      [ogImageApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        ogImageApi->putImage(req, std::move(cb), id);
      },
      {drogon::Put});

  // Per-tree share video (og-share-video): owner-only PUT of the raw mp4/webm loop; the GET
  // (canRead-gated) is what the scraper's og:video tag points at — 404 on any miss, since the
  // og:image poster is the fallback. Same path, two verbs.
  app.registerHandler(
      "/v1/trees/{id}/og-video",
      [ogVideoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        ogVideoApi->putVideo(req, std::move(cb), id);
      },
      {drogon::Put});
  app.registerHandler(
      "/v1/trees/{id}/og-video",
      [ogVideoApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        ogVideoApi->getVideo(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/trees/{id}/diagnostics",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getDiagnostics(req, std::move(cb), id);
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/trees/{id}/activity",
      [api](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        api->getActivity(req, std::move(cb), id);
      },
      {drogon::Get});

  // Tending: POST a sentence to start a server-side agent run — 202 + a run id at once, the loop
  // carries on without the browser. GET the run by id is the catch-up a returning phone makes long
  // after its socket died; it never surfaces a run that isn't the caller's. The POST wears the
  // tending rate-limit pair above; the GET is a plain read under the general ceiling.
  app.registerHandler(
      "/v1/trees/{id}/tend",
      [tendingApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        tendingApi->tend(req, std::move(cb), id);
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/tend/{runId}",
      [tendingApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& runId) {
        tendingApi->getRun(req, std::move(cb), runId);
      },
      {drogon::Get});
  // The meter + receipts ledger: this account's month budget, its reset, and its recent runs. A
  // plain read under the general ceiling, available to any signed-in caller even while tending is dark.
  app.registerHandler(
      "/v1/tending",
      [tendingApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        tendingApi->summary(req, std::move(cb));
      },
      {drogon::Get});

  // Weekly reminders. The two settings verbs ride the ordinary session; the pause POST carries no
  // credential but the secret from someone's own mail, and answers 204 either way so it can never
  // be asked whose reminders exist. The admin sweep is the rehearsal door — closed unless
  // REMINDERS_ADMIN_TOKEN is set, and it refuses a time-travelling asOfMs once the engine is armed.
  app.registerHandler(
      "/v1/reminders",
      [remindersApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        remindersApi->getSettings(req, std::move(cb));
      },
      {drogon::Get});
  app.registerHandler(
      "/v1/reminders",
      [remindersApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        remindersApi->patchSettings(req, std::move(cb));
      },
      {drogon::Patch});
  app.registerHandler(
      "/v1/reminders/pause",
      [remindersApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        remindersApi->pause(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/reminders/unsubscribe",
      [remindersApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        remindersApi->unsubscribe(req, std::move(cb));
      },
      {drogon::Post});
  app.registerHandler(
      "/v1/admin/reminders/sweep",
      [remindersApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        remindersApi->sweep(req, std::move(cb));
      },
      {drogon::Post});

  // The unfurlable share page: /t/:id serves the SPA shell with this tree's OG meta baked in.
  // Caddy path-routes /t/* here; everything else stays the static SPA.
  app.registerHandler(
      "/t/{id}",
      [sharePageApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        sharePageApi->page(req, std::move(cb), id);
      },
      {drogon::Get});

  // The public wall. Unauthenticated by design — it lists only trees whose owners asked to be
  // listed, and every card links straight to that tree's own share page.
  app.registerHandler(
      "/gallery",
      [galleryApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        galleryApi->page(req, std::move(cb));
      },
      {drogon::Get});

  // The same index as JSON, for the client-rendered surfaces (the shelf at the end of your own
  // gallery, and /browse). Anonymous-allowed like the wall — a session only adds the two facts a
  // row wears about its reader, and never changes which trees are on it.
  app.registerHandler(
      "/v1/gallery",
      [galleryApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
        galleryApi->index(req, std::move(cb));
      },
      {drogon::Get});

  // The og:image scrapers fetch: the tree's own card, canRead-gated, 302 to the generic card
  // on any miss. Public, unauthenticated (a private tree's card resolves only for its owner).
  app.registerHandler(
      "/og/{id}.png",
      [ogImageApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
        ogImageApi->getImage(req, std::move(cb), id);
      },
      {drogon::Get});

  // Paste-import escalation: anonymous allowed (the birth canvas has no account); abuse is
  // the compose rate-limit pair above. CORS rides the shared policy like every other route.
  app.registerHandler(
      "/v1/compose",
      [composeApi](const drogon::HttpRequestPtr& req, HttpCallback&& cb) { composeApi->compose(req, std::move(cb)); },
      {drogon::Post});
}

}
