#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/LogService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// ASK'S THREADS (§O) OVER REST, AND THEY LIVE HERE AND NOT ON ASK'S API. AskApi is the ask DOOR —
// one question into one thread — and a deployment with no vendor key registers no `POST
// /v1/gym/ask` at all; the conversations a lifter already had are still theirs to read, to export
// and to delete. A thread is somebody's own words, not a feature of the model that answered them.
// One of five HTTP adapters mirroring the five aggregate ports (TrainingApi holds the status ladder
// they all share; routes.cpp is the one mount). It needs the log service and the auth seam and
// nothing else.
class ThreadsApi {
public:
  ThreadsApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth);

  void listThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET  /v1/gym/threads
  void getThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                 const std::string& id);                                      // GET  /v1/gym/threads/{id}
  void deleteThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                    const std::string& id);                                   // DELETE /v1/gym/threads/{id}
  void exportThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb);   // GET  /v1/gym/export/threads

private:
  std::shared_ptr<LogService> log_;
  std::shared_ptr<AuthService> auth_;
};

}
