#pragma once

#include "application/AuthService.h"
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

// The public gallery, on its two surfaces. Both read one index — `listPublic` for the candidates
// and domain/Gallery.h for the eligibility and the ranking — so a tree can never sit in two
// different places on two pages of the same product.
//
//   GET /gallery     the wall: server-rendered, anonymous, real anchors in the served HTML.
//                    A crawler (and a stranger arriving from one shared tree) needs a path to
//                    the next tree, and until this page existed a public tree was indexable but
//                    reachable from nowhere.
//   GET /v1/gallery  the same index as JSON, for the in-product shelf and /browse. Anonymous
//                    callers get exactly the wall's rows; a signed-in caller's rows additionally
//                    say whether each tree is theirs and whether they have already forked it.
//
// Neither surface makes a per-caller access decision: listing is the owner's deliberate act past
// unlisted, and `listPublic` filters on it in SQL, so an unlisted tree reaches neither.
class GalleryApi {
public:
  GalleryApi(std::shared_ptr<TreeRepository> trees, std::shared_ptr<ProgressRepository> progress,
             std::shared_ptr<AuthService> auth, std::string webRoot);

  void page(const drogon::HttpRequestPtr& req, HttpCallback&& callback);
  void index(const drogon::HttpRequestPtr& req, HttpCallback&& callback);

  // The pure templating boundary (tested directly): the card grid, spliced between gallery.html's
  // sentinels. An empty wall returns the template untouched, so the designed empty state — which
  // lives between those same sentinels — is what gets served.
  static std::string renderWall(const std::string& shell, const std::vector<GalleryEntry>& wall);

  // One page of the wall, and the JSON index's cap and default alike. Past this a reader is
  // scrolling, not browsing; a caller who wants more walks the cursor.
  static constexpr std::size_t kWallLimit = 60;

private:
  // Every listed tree, loaded and paired with its owner's overlay — the input both surfaces rank.
  std::vector<WallCandidate> candidates();

  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<ProgressRepository> progress_;
  std::shared_ptr<AuthService> auth_;
  std::string webRoot_;
};

}
