#pragma once

#include "products/roadmap/ports/PlanComposer.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// Pasted text in, a markdown plan out. {"stream": true} answers as SSE instead: one `delta`
// event per text delta, closed by `done` or `fail`.
class ComposeApi {
public:
  explicit ComposeApi(std::shared_ptr<PlanComposer> composer);

  void compose(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST /v1/compose

private:
  std::shared_ptr<PlanComposer> composer_;
};

}
