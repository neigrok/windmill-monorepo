#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/ports/PreferencesRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// One document per account, read whole; the read never 404s.
class PreferencesApi {
public:
  PreferencesApi(std::shared_ptr<PreferencesRepository> preferences,
                 std::shared_ptr<AuthService> auth);

  void preferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET  /v1/gym/preferences

private:
  std::shared_ptr<PreferencesRepository> preferences_;
  std::shared_ptr<AuthService> auth_;
};

}
