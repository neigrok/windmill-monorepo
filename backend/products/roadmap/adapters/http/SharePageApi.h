#pragma once

#include "platform/application/AuthService.h"
#include "products/roadmap/application/EngineReadModels.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/Access.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/ports/OgVideoRepository.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <cstddef>
#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Serves the SPA shell at GET /t/:id. For an anon-readable tree it rewrites the fenced unfurl
// meta with the tree's own; a private or absent tree gets the shell byte-for-byte verbatim, so
// private stays indistinguishable from absent. Where the engine serves roadmap, `engine` is set and the tree is read from
// its records instead of its room (roadmap-on-the-engine.md §7).
class SharePageApi {
public:
  SharePageApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
               std::shared_ptr<AuthService> auth, std::shared_ptr<OgVideoRepository> videos,
               std::string webRoot, std::string appOrigin, std::shared_ptr<EngineReadModels> engine);

  void page(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id);

  // Splice this tree's unfurl meta between the index.html sentinels, keeping the sentinels;
  // returns the shell unchanged if the fence is absent. `title` is escaped here. The page's own
  // address is the tree's share address on `origin`, and its pictures are served from there too.
  static std::string renderShell(const std::string& shell, const std::string& origin, const std::string& title,
                                 std::size_t steps, Visibility visibility, const std::string& id,
                                 const ForkLineage& lineage, bool hasVideo);

private:
  std::shared_ptr<RoomRegistry> registry_;
  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<OgVideoRepository> videos_;
  std::string webRoot_;
  std::string appOrigin_;
  std::shared_ptr<EngineReadModels> engine_;
};

}
