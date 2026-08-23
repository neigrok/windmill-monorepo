#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/AskService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

//   ask in  : { "thread": "thr_…", "question": "…" }
//   ask out : { "answer": "…", "steps": [ { "tool", "failed" } ], "read": { … },
//               "proposals": [ "prop_…" ], "thread": "thr_…" }
//
// The thread id is the client's to mint; a fresh one opens a conversation. The client sends no
// history. The route is registered only on a deployment with a vendor key.
class AskApi {
public:
  AskApi(std::shared_ptr<AskService> ask, std::shared_ptr<AuthService> auth);

  void ask(const drogon::HttpRequestPtr& req, HttpCallback&& cb);  // POST /v1/gym/ask

private:
  std::shared_ptr<AskService> ask_;
  std::shared_ptr<AuthService> auth_;
};

}
