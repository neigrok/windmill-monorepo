#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/ThreadService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Ask's threads over REST, here and NOT on AskApi: a deployment with no vendor key registers no
// `POST /v1/gym/ask` at all, and the conversations a lifter already had stay theirs to read, export
// and delete. One of five HTTP adapters mirroring the five aggregate ports (TrainingApi holds the
// status ladder they all share; routes.cpp is the one mount).
class ThreadsApi {
public:
  ThreadsApi(std::shared_ptr<ThreadService> threads, std::shared_ptr<AuthService> auth);

  void listThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET  /v1/gym/threads
  void getThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                 const std::string& id);                                      // GET  /v1/gym/threads/{id}
  void deleteThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                    const std::string& id);                                   // DELETE /v1/gym/threads/{id}
  void exportThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/export/threads

private:
  std::shared_ptr<ThreadService> threads_;
  std::shared_ptr<AuthService> auth_;
};

}
