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

// The nudge control surface, mirroring roadmap's RemindersApi. Settings are owner-scoped; pause and
// unsubscribe are UNCREDENTIALED on purpose — their authority is the secret in the mail the user was
// sent (looked up by its digest), so a tap from an email client with no session still works. The
// admin sweep is an operator rehearsal gated by a shared token, able to time-travel (asOfMs) and run
// dry, so the whole engine can be driven in a test without waiting for a real due instant — and,
// like roadmap's, a time-travelling sweep is always a rehearsal and is refused outright once the
// feature is armed, because otherwise one request mails the allowlist early and eats the real slot.
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
