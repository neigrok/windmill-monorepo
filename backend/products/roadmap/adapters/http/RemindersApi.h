#pragma once

#include "platform/application/AuthService.h"
#include "platform/ports/Clock.h"
#include "products/roadmap/ports/ReminderRepository.h"
#include "platform/ports/TokenGenerator.h"
#include "products/roadmap/application/ReminderSweep.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The reminder engine's five doors.
//
// get/patch sit behind the usual session; sweep is the operator's rehearsal door, closed unless
// REMINDERS_ADMIN_TOKEN opens it. pause and unsubscribe take no credential at all — the only
// thing either can be reached with is the secret in someone's own mail — and each answers the
// same whether or not that secret matches, so neither is an oracle for which secrets exist. Both
// spend the same per-send pause secret, so either path pauses exactly once.
//
// Both are POST-only: link scanners and mail clients prefetch every URL in an email, and a GET
// door would unsubscribe people who never pressed anything.
//
// Every field is type-checked before it is read: jsoncpp throws on a conversion it cannot make,
// and an exception out of a handler is a 500 an anonymous caller can mint at will.
class RemindersApi {
public:
  RemindersApi(std::shared_ptr<ReminderSweep> sweep, std::shared_ptr<ReminderRepository> reminders,
               std::shared_ptr<AuthService> auth, std::shared_ptr<TokenGenerator> tokens,
               std::shared_ptr<Clock> clock, std::string adminToken);

  void getSettings(const drogon::HttpRequestPtr& req, HttpCallback&& callback);   // GET   /v1/reminders
  void patchSettings(const drogon::HttpRequestPtr& req, HttpCallback&& callback); // PATCH /v1/reminders
  void pause(const drogon::HttpRequestPtr& req, HttpCallback&& callback);         // POST  /v1/reminders/pause
  void unsubscribe(const drogon::HttpRequestPtr& req, HttpCallback&& callback);   // POST  /v1/reminders/unsubscribe
  void sweep(const drogon::HttpRequestPtr& req, HttpCallback&& callback);         // POST  /v1/admin/reminders/sweep

private:
  std::shared_ptr<ReminderSweep> sweep_;
  std::shared_ptr<ReminderRepository> reminders_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<TokenGenerator> tokens_;
  std::shared_ptr<Clock> clock_;
  std::string adminToken_;
};

}
