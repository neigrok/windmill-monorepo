#pragma once

#include "platform/application/AuthService.h"
#include "products/journal/application/EchoSweep.h"
#include "products/journal/ports/EchoRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The echo read surface. Owner-scoped, and entitlement-free by design: a non-subscriber's echoes
// are simply an empty list (nothing was ever computed for them), so there is no locked state to
// render — "absent, not locked". The admin sweep is an operator rehearsal gated by a shared token,
// able to drive one nightly pass at an arbitrary instant over an arbitrary look-back window.
class EchoApi {
public:
  EchoApi(std::shared_ptr<EchoRepository> echoes, std::shared_ptr<EchoSweep> sweep,
          std::shared_ptr<AuthService> auth, std::string adminToken);

  void listEchoes(const drogon::HttpRequestPtr& req, HttpCallback&& cb);                  // GET  /v1/journal/echoes?from=&to=
  void dismiss(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& date);  // POST /v1/journal/echoes/{date}/dismiss
  void adminSweep(const drogon::HttpRequestPtr& req, HttpCallback&& cb);                  // POST /v1/admin/journal/echo/sweep

private:
  std::shared_ptr<EchoRepository> echoes_;
  std::shared_ptr<EchoSweep> sweep_;
  std::shared_ptr<AuthService> auth_;
  std::string adminToken_;
};

}
