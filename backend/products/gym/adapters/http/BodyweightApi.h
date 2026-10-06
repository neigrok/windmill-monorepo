#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/BodyweightService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

//   list   ?from=YYYY-MM-DD&to=YYYY-MM-DD   out : { "entries": [ <entry> ], "latest": <entry> | null }
//   entry      : { "dateLocal": "YYYY-MM-DD", "weightKg": n, "recordedAt": ms }
//
// A bound that is not a calendar day is a 400, `could not read that date`.
class BodyweightApi {
public:
  BodyweightApi(std::shared_ptr<BodyweightService> bodyweight, std::shared_ptr<AuthService> auth);

  void listEntries(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET    /v1/gym/bodyweight

private:
  std::shared_ptr<BodyweightService> bodyweight_;
  std::shared_ptr<AuthService> auth_;
};

}
