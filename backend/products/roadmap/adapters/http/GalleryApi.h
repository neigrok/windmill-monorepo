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

// The public gallery, on its two surfaces. Both read one index — `listPublic` for the candidates
// and domain/Gallery.h for the eligibility and the ranking.
//
//   GET /gallery     the wall: server-rendered, anonymous, real anchors in the served HTML.
//   GET /v1/gallery  the same index as JSON, for the in-product shelf and /browse. Anonymous
//                    callers get exactly the wall's rows; a signed-in caller's rows additionally
//                    say whether each tree is theirs and whether they have already forked it.
//
// Neither surface makes a per-caller access decision: `listPublic` filters on visibility in SQL,
// so an unlisted tree reaches neither.
class GalleryApi {
public:
  GalleryApi(std::shared_ptr<TreeRepository> trees, std::shared_ptr<ProgressRepository> progress,
             std::shared_ptr<AuthService> auth, std::string webRoot);

  void page(const drogon::HttpRequestPtr& req, HttpCallback&& callback);
  void index(const drogon::HttpRequestPtr& req, HttpCallback&& callback);

  // The card grid, spliced between gallery.html's sentinels. An empty wall returns the template
  // untouched, so the designed empty state between those sentinels is what gets served.
  static std::string renderWall(const std::string& shell, const std::vector<GalleryEntry>& wall);

  // One page of the wall, and the JSON index's cap and default alike; more walks the cursor.
  static constexpr std::size_t kWallLimit = 60;

private:
  // Every listed tree, paired with its owner's overlay: the input both surfaces rank.
  std::vector<WallCandidate> candidates();

  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<ProgressRepository> progress_;
  std::shared_ptr<AuthService> auth_;
  std::string webRoot_;
};

}
