#pragma once

#include "platform/application/AuthService.h"
#include "platform/ports/AuthRepository.h"
#include "platform/ports/Clock.h"
#include "platform/ports/SyncStore.h"
#include "platform/ports/TokenGenerator.h"

#include <drogon/HttpAppFramework.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm::probe {

// The dev stack's endpoints: only windmill_server_probe mounts them.
class DevApi {
public:
  using Reply = std::function<void(const drogon::HttpResponsePtr&)>;

  DevApi(AuthService& auth, AuthRepository& links, TokenGenerator& tokens, Clock& clock, sync::SyncStore& store);

  // POST /v1/dev/sign-in {email} → {account, token}, the token a session as good as the web's cookie.
  void signIn(const drogon::HttpRequestPtr& req, Reply&& reply);
  // POST /v1/dev/sync/epoch → {epoch}, regenerated as a database restore would (engine.md D-18).
  void regenerateEpoch(Reply&& reply);

private:
  AuthService& auth_;
  AuthRepository& links_;
  TokenGenerator& tokens_;
  Clock& clock_;
  sync::SyncStore& store_;
};

void registerDevRoutes(drogon::HttpAppFramework& app, const std::shared_ptr<DevApi>& api);

}
