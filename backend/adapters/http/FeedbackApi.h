#pragma once

#include "application/AuthService.h"
#include "ports/FeedbackRepository.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The feedback door: anyone — signed-in or ghost — POSTs one note. Boundary-only: trim and
// bound the message, truncate the optional side fields, resolve the caller server-side,
// store one row. A body-supplied identity is never read.
class FeedbackApi {
public:
  FeedbackApi(std::shared_ptr<FeedbackRepository> feedback, std::shared_ptr<AuthService> auth);

  void submit(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST /v1/feedback

private:
  std::shared_ptr<FeedbackRepository> feedback_;
  std::shared_ptr<AuthService> auth_;
};

}
