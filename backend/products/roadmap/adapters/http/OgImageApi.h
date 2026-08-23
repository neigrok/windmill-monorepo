#pragma once

#include "platform/application/AuthService.h"
#include "products/roadmap/ports/OgImageRepository.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Per-tree share unfurl cards. The client renders its own tree to a 1200×630
// PNG and PUTs it here — owner-only. GET /og/:id.png then serves that PNG as the link's
// og:image, behind the same read gate as the share page (canRead): a private tree's card is
// owner-only. Any miss — no image, an unreadable tree, an absent one — redirects to the generic
// card rather than 404, so a shared link never unfurls with a broken image.
class OgImageApi {
public:
  OgImageApi(std::shared_ptr<OgImageRepository> images, std::shared_ptr<TreeRepository> trees,
             std::shared_ptr<AuthService> auth);

  void putImage(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id);
  void getImage(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& id);

private:
  std::shared_ptr<OgImageRepository> images_;
  std::shared_ptr<TreeRepository> trees_;
  std::shared_ptr<AuthService> auth_;
};

}
