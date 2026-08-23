#pragma once

#include "platform/application/AuthService.h"
#include "products/roadmap/domain/Gallery.h"
#include "products/roadmap/ports/ProgressRepository.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// GET /gallery renders the wall as HTML; GET /v1/gallery serves the same index as JSON, adding
// per-row `mine` and `forked` for a signed-in caller. Neither makes a per-caller access decision:
// listPublic filters on visibility in SQL.
class GalleryApi {
public:
  GalleryApi(std::shared_ptr<TreeRepository> trees, std::shared_ptr<ProgressRepository> progress,
             std::shared_ptr<AuthService> auth, std::string webRoot);

  void page(const drogon::HttpRequestPtr& req, HttpCallback&& callback);
  void index(const drogon::HttpRequestPtr& req, HttpCallback&& callback);

  // The card grid, spliced between gallery.html's sentinels; an empty wall returns the shell as is.
  static std::string renderWall(const std::string& shell, const std::vector<GalleryEntry>& wall);

  // The wall's page size, and the JSON index's cap and default alike.
  static constexpr std::size_t kWallLimit = 60;

private:
  std::vector<WallCandidate> candidates();

  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<ProgressRepository> progress_;
  std::shared_ptr<AuthService> auth_;
  std::string webRoot_;
};

}
