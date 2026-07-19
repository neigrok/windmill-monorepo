#pragma once

#include "application/AuthService.h"
#include "application/TendingService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Tending over REST: tell a tree a sentence, and read the run it becomes. The POST answers at
// once — 202 with a run id while the agent loop carries on server-side — because a tend run is a
// job the browser is free to walk away from (domain/Tending.h). The GET is the catch-up door a
// returning phone knocks on after its socket died: it works long after the request that started
// the run, and never surfaces a run that isn't the caller's. Credentialed by the same wm_session
// cookie / Bearer token every other REST surface resolves through.
class TendingApi {
public:
  TendingApi(std::shared_ptr<TendingService> tending, std::shared_ptr<AuthService> auth);

  void tend(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);  // POST /v1/trees/:id/tend
  void getRun(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& runId);  // GET  /v1/tend/:runId

private:
  std::shared_ptr<TendingService> tending_;
  std::shared_ptr<AuthService> auth_;
};

}
