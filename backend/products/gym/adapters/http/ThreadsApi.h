#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/ThreadService.h"
#include "products/gym/application/AskService.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <atomic>
#include <trantor/net/EventLoopThreadPool.h>
#include <memory>
#include <string>

namespace wm::gym {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Ask's threads, mounted on a deployment with no vendor key too, where `POST /v1/gym/ask` is absent.
class ThreadsApi {
public:
  ThreadsApi(std::shared_ptr<ThreadService> threads, std::shared_ptr<AuthService> auth, std::shared_ptr<AskService> ask = nullptr);

  void listThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb);     // GET  /v1/gym/threads
  void getThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                 const std::string& id);                                      // GET  /v1/gym/threads/{id}
  void deleteThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                    const std::string& id);                                   // DELETE /v1/gym/threads/{id}

  void putImage(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& thread, const std::string& id);
  void getImage(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& thread, const std::string& id);
  void stopGeneration(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& thread, const std::string& requestId);

private:
  std::shared_ptr<ThreadService> threads_;
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<AskService> ask_;
  std::atomic<unsigned> uploadCount_{0};
  trantor::EventLoopThreadPool uploads_{2};
};

}
