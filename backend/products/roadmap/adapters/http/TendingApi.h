#pragma once

#include "platform/application/AuthService.h"
#include "products/roadmap/application/TendingService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Tending over REST. POST answers 202 with a run id while the agent loop carries on server-side;
// GET reads the outcome, and never surfaces a run that is not the caller's.
class TendingApi {
public:
  TendingApi(std::shared_ptr<TendingService> tending, std::shared_ptr<AuthService> auth);

  void tend(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& treeId);  // POST /v1/trees/:id/tend
  void getRun(const drogon::HttpRequestPtr& req, HttpCallback&& callback, const std::string& runId);  // GET  /v1/tend/:runId
  void summary(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // GET  /v1/tending

private:
  std::shared_ptr<TendingService> tending_;
  std::shared_ptr<AuthService> auth_;
};

}
