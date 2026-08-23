#pragma once

#include "platform/application/AuthService.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "platform/domain/Access.h"
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
// private stays indistinguishable from absent.
class SharePageApi {
public:
  SharePageApi(std::shared_ptr<RoomRegistry> registry, std::shared_ptr<TreeRepository> trees,
               std::shared_ptr<AuthService> auth, std::shared_ptr<OgVideoRepository> videos,
               std::string webRoot);

  void page(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id);

  // Splice this tree's unfurl meta between the index.html sentinels, keeping the sentinels;
  // returns the shell unchanged if the fence is absent. `title` is escaped here.
  static std::string renderShell(const std::string& shell, const std::string& title,
                                 std::size_t steps, Visibility visibility, const std::string& id,
                                 const ForkLineage& lineage, bool hasVideo);

private:
  std::shared_ptr<RoomRegistry> registry_;
  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<OgVideoRepository> videos_;
  std::string webRoot_;
};

}
