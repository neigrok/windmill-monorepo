#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/AskService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// ASK'S ONE ROUTE — the SECOND DOOR onto the tools an agent already drives over MCP, for a lifter who
// does not have an agent of their own. There is no third thing here: the same LogService, the same
// seventeen declarations, the same owner scoping; what this adds is a model on our side of the wire
// and the bill that comes with it, which is why every gate below is read before the question travels
// anywhere.
//
// It is REQUEST/RESPONSE and deliberately not a stream. The only streaming machinery in this repo is
// roadmap's hand-rolled HTTP/1.1 + chunked + SSE decoder, and an answer that arrives in one reply does
// not earn a second consumer of two hundred lines of parser.
//
// It is also STATELESS: the client sends the turns so far, so there is no conversation table, no
// thread id, and nothing a lifter would have to be told about when they close their account.
//
// The status ladder, and what a client does with each: 400 is the client's and terminal — a body that
// is not a conversation, a blank question, a turn past the byte cap, more turns than Ask holds; 409
// `ask-session-open` is the design's "never offered mid-session", enforced here because three clients
// each remembering it is not a rule; 429 `ask-daily-limit` is the day's cap, which NOTHING BUYS OFF —
// there is no checkout in this product, so a client that answered it with an upgrade would be selling
// a door painted on a wall; 429 `ask-out-of-budget` is our own AI ceiling behind it, likewise not for
// sale; 502 is the model not answering, which is the one worth offering again; 503 is no vendor wired
// at all, which the route being registered at boot already makes unreachable in production.
class AskApi {
public:
  AskApi(std::shared_ptr<AskService> ask, std::shared_ptr<AuthService> auth);

  void ask(const drogon::HttpRequestPtr& req, HttpCallback&& cb);  // POST /v1/gym/ask

private:
  std::shared_ptr<AskService> ask_;
  std::shared_ptr<AuthService> auth_;
};

}
