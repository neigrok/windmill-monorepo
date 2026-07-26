#pragma once

#include "application/AuthService.h"
#include "ports/Clock.h"
#include "ports/ReminderRepository.h"
#include "ports/TokenGenerator.h"
#include "application/ReminderSweep.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The reminder engine's five doors.
//
// Two are ordinary settings surfaces behind the usual session (get/patch). One is the operator's
// rehearsal door, closed unless REMINDERS_ADMIN_TOKEN opens it (sweep). The other two — pause and
// unsubscribe — take no credential at all, because the only thing either can be reached with is the
// secret in someone's own mail, and each answers the same whether or not that secret matches. A door
// that reported "no such token" would be an oracle for which secrets exist. The two differ only in
// who presses them: pause is the human page's button, unsubscribe (RFC 8058 one-click) is the POST a
// mail client makes for the reader. Both spend the same per-send pause secret, so either path pauses
// exactly once.
//
// Neither may act on a GET: corporate link scanners and Outlook prefetch every URL in an email, and
// a GET door would silently unsubscribe people who never pressed anything. Both are POST-only, so a
// scanner's GET reaches nothing.
//
// Every one of them answers a caller who may have typed anything at all, so each field is checked
// for its type before it is read: jsoncpp throws on a conversion it cannot make, and an exception
// out of a handler is a 500 and a Sentry event that an anonymous caller can mint at will.
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
