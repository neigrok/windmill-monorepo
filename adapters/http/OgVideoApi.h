#pragma once

#include "application/AuthService.h"
#include "ports/OgVideoRepository.h"
#include "ports/TreeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Per-tree share videos (og-share-video). The client renders + encodes a short mp4/webm loop and
// PUTs it here — owner-only. GET /v1/trees/:id/og-video then serves it as the link's og:video,
// behind the same read gate as the share page (canRead): a private tree's video is owner-only.
// Unlike the og:image card there is NO generic fallback — the og:image poster IS the fallback — so
// a miss (no video, an unreadable tree, an absent one) is a plain 404 here, not a redirect.
class OgVideoApi {
public:
  OgVideoApi(std::shared_ptr<OgVideoRepository> videos, std::shared_ptr<TreeRepository> trees,
             std::shared_ptr<AuthService> auth);

  void putVideo(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id);
  void getVideo(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id);

private:
  std::shared_ptr<OgVideoRepository> videos_;
  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<AuthService> auth_;
};

}
