#pragma once

#include "platform/application/AuthService.h"
#include "products/roadmap/ports/OgVideoRepository.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Per-tree share videos: PUT is owner-only, GET is gated by canRead. There is no generic
// fallback here — any miss is a plain 404.
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
