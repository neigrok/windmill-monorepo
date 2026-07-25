#pragma once

#include "domain/Gallery.h"
#include "ports/ProgressRepository.h"
#include "ports/TreeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The public wall at GET /gallery: every tree its owner listed, ranked by the forks it inspired.
// Unauthenticated and server-rendered — the cards are real anchors in the served HTML, which is
// the whole point. A crawler (and a stranger arriving from one shared tree) needs a path to the
// next tree, and until this page existed a public tree was indexable but reachable from nowhere.
//
// Reads only the listed set, so there is no per-caller access decision to make: publishing is
// the owner's deliberate act, and `listPublic` filters on it in SQL.
class GalleryApi {
public:
  GalleryApi(std::shared_ptr<TreeRepository> trees, std::shared_ptr<ProgressRepository> progress,
             std::string webRoot);

  void page(const drogon::HttpRequestPtr& req, HttpCallback&& callback);

  // The pure templating boundary (tested directly): the card grid, spliced between gallery.html's
  // sentinels. An empty wall returns the template untouched, so the designed empty state — which
  // lives between those same sentinels — is what gets served.
  static std::string renderWall(const std::string& shell, const std::vector<GalleryEntry>& wall);

  // One page of the wall. Past this a stranger is scrolling, not browsing.
  static constexpr std::size_t kWallLimit = 60;

private:
  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<ProgressRepository> progress_;
  std::string webRoot_;
};

}
