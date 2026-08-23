#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/AskService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Ask's one route: the second door onto the tools an agent drives over MCP, for a lifter who has no
// agent of their own. The same three services under GymTools (TrainingService, CatalogService,
// ProgramService), the same declarations, the same owner scoping; what this adds is a model on our
// side of the wire and the bill with it, so every gate is read before the question travels anywhere.
//
// Request/response, not a stream.
//
//   ask in  : { "thread": "thr_…", "question": "…" }
//   ask out : { "answer": "…", "steps": [ { "tool", "failed" } ], "read": { … },
//               "proposals": [ "prop_…" ], "thread": "thr_…" }
//
// The thread id is the CLIENT's to mint, and a fresh one opens a conversation titled by this question
// verbatim. A client sends no history: the stored thread is what the model is shown.
//
// The threads themselves are read, exported and deleted through `ThreadsApi` and NOT here: a
// deployment with no vendor key registers no route on this class at all.
//
// The status ladder: 400 is the client's and terminal — a body that is not a question, a malformed
// thread id, a blank question, a question past the byte cap; 409 `ask-thread-taken` is an id somebody
// else holds (mint another); 409 `ask-thread-full` is answered by opening a new conversation; 409
// `ask-session-open` is "never offered mid-session", enforced here rather than in three clients; 429
// `ask-daily-limit` is the day's cap and NOTHING BUYS IT OFF — there is no checkout in this product;
// 429 `ask-out-of-budget` is our own AI ceiling behind it; 502 is the model not answering, the one
// worth offering again; 503 is no vendor wired at all.
class AskApi {
public:
  AskApi(std::shared_ptr<AskService> ask, std::shared_ptr<AuthService> auth);

  void ask(const drogon::HttpRequestPtr& req, HttpCallback&& cb);  // POST /v1/gym/ask

private:
  std::shared_ptr<AskService> ask_;
  std::shared_ptr<AuthService> auth_;
};

}
