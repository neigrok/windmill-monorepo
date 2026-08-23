#pragma once

#include "platform/application/AuthService.h"
#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"
#include "products/journal/application/NudgeSweep.h"
#include "products/journal/ports/NudgeRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Settings are owner-scoped. Pause and unsubscribe are uncredentialed: their authority is the
// secret in the mail, looked up by its digest. The admin sweep is gated by a shared token and can
// time-travel (asOfMs) or run dry; a time-travelling sweep is always dry and is refused once the
// feature is armed.
class NudgeApi {
public:
  NudgeApi(std::shared_ptr<NudgeRepository> nudges, std::shared_ptr<NudgeSweep> sweep,
           std::shared_ptr<AuthService> auth, std::shared_ptr<TokenGenerator> tokens,
           std::shared_ptr<Clock> clock, std::string adminToken);

  void getSettings(const drogon::HttpRequestPtr& req, HttpCallback&& cb);      // GET   /v1/journal/nudge
  void patchSettings(const drogon::HttpRequestPtr& req, HttpCallback&& cb);    // PATCH /v1/journal/nudge
  void pause(const drogon::HttpRequestPtr& req, HttpCallback&& cb);            // POST  /v1/journal/nudge/pause
  void unsubscribe(const drogon::HttpRequestPtr& req, HttpCallback&& cb);      // POST  /v1/journal/nudge/unsubscribe
  void adminSweep(const drogon::HttpRequestPtr& req, HttpCallback&& cb);       // POST  /v1/admin/journal/nudge/sweep

private:
  std::shared_ptr<NudgeRepository> nudges_;
  std::shared_ptr<NudgeSweep> sweep_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<TokenGenerator> tokens_;
  std::shared_ptr<Clock> clock_;
  std::string adminToken_;
};

}
