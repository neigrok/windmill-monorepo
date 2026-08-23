#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/PreferencesService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// One document per account, read and written whole; the read never 404s. Every refusal the write can
// make carries a code (`preferences-unreadable`, `unknown-unit`, `rest-target`).
class PreferencesApi {
public:
  PreferencesApi(std::shared_ptr<PreferencesService> preferences,
                 std::shared_ptr<AuthService> auth);

  void preferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET  /v1/gym/preferences
  void savePreferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb); // PUT  /v1/gym/preferences

private:
  std::shared_ptr<PreferencesService> preferences_;
  std::shared_ptr<AuthService> auth_;
};

}
