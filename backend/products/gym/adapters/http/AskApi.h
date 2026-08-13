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
// IT IS NO LONGER STATELESS, AND THAT IS W11 REVERSING W7 BY THE OWNER'S RULING. W7 shipped this
// route stateless on purpose — the client sent the turns so far, so there was no conversation table
// and no thread id — and the reason it changed is a product reason rather than a technical one: a
// conversation about your bench plateau is worth more in six weeks than it was that evening. So the
// body is now ONE QUESTION INTO ONE THREAD:
//
//   ask in  : { "thread": "thr_…", "question": "…" }
//   ask out : { "answer": "…", "steps": [ { "tool", "failed" } ], "read": { … },
//               "proposals": [ "prop_…" ], "thread": "thr_…" }
//
// The thread id is the CLIENT's to mint, like every other id in this product, and a fresh one opens a
// conversation titled by this question verbatim. A client no longer sends a history: the stored
// thread is what the model is shown, so the conversation a lifter reads back is the one it saw.
//
// The threads themselves are read, exported and deleted through `GymApi` and NOT here, and that is
// deliberate: a deployment with no vendor key registers no route on this class at all, and the
// conversations a lifter already had are still theirs.
//
// The status ladder, and what a client does with each: 400 is the client's and terminal — a body that
// is not a question, a malformed thread id, a blank question, a question past the byte cap; 409
// `ask-thread-taken` is an id somebody else holds (mint another); 409 `ask-thread-full` is this
// conversation being as long as Ask holds, which the client answers by opening a new one; 409
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
