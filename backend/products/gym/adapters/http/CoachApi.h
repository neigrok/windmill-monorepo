#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/CoachService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The panel's one route — the SECOND DOOR onto the tools an agent already drives over MCP, for a
// lifter who does not have an agent of their own. There is no third thing here: the same LogService,
// the same fifteen declarations, the same owner scoping; what this adds is a model on our side of the
// wire and the bill that comes with it, which is why every gate below is read before the question
// travels anywhere.
//
// It is REQUEST/RESPONSE and deliberately not a stream. The only streaming machinery in this repo is
// roadmap's hand-rolled HTTP/1.1 + chunked + SSE decoder, and a panel that answers in one reply does
// not earn a second consumer of two hundred lines of parser.
//
// It is also STATELESS: the client sends the turns so far, so there is no conversation table, no
// thread id, and nothing a lifter would have to be told about when they close their account.
//
// The status ladder, and what a client does with each: 400 is the client's and terminal — a body
// that is not a conversation, a blank question, a turn past the byte cap, more turns than a panel
// holds; 403 `coach-not-entitled` is the paywall, and the web draws it UP FRONT so nobody types a
// question they will lose to it; 404 is the fact that this account cannot read that workout, absent
// and another's alike; 429 `coach-rate-limited` is the per-account brake and `coach-out-of-budget` the
// AI ceiling behind it, which no purchase lifts and so the client must not sell against; 502 is the model not
// answering, which is the one worth offering again; 503 is no vendor wired at all, which the route
// being registered at boot already makes unreachable in production.
class CoachApi {
public:
  CoachApi(std::shared_ptr<CoachService> coach, std::shared_ptr<AuthService> auth);

  void ask(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
           const std::string& id);  // POST /v1/gym/sessions/{id}/coach

private:
  std::shared_ptr<CoachService> coach_;
  std::shared_ptr<AuthService> auth_;
};

}
