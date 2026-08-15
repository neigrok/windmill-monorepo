#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/LogService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// §I's rows over REST — one document per account, read and written whole. One of five HTTP
// adapters mirroring the five aggregate ports (TrainingApi holds the status ladder they all share;
// routes.cpp is the one mount). It needs the log service and the auth seam and nothing else.
//
// The read never 404s — a lifter with no row is served the defaults — and the write is the whole
// document, so the two carry the same shape in both directions.
//
// The settings write keeps a tighter rule than most of gym: EVERY refusal it can make carries a
// code (`preferences-unreadable`, `unknown-unit`, `rest-target` among the sixteen), because it
// carries five independent values at once, and a single "could not read that" would leave the
// screen unable to say WHICH row a lifter has to go back and fix.
class PreferencesApi {
public:
  PreferencesApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth);

  void preferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET  /v1/gym/preferences
  void savePreferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb); // PUT  /v1/gym/preferences

private:
  std::shared_ptr<LogService> log_;
  std::shared_ptr<AuthService> auth_;
};

}
