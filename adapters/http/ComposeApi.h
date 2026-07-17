#pragma once

#include "ports/PlanComposer.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <functional>
#include <memory>

namespace wm {

using HttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;

// The paste-import escalation door (F3): anonymous callers on the birth canvas POST raw
// pasted text and get back a markdown plan in the paste grammar. Every outcome is a typed
// code the client branches on — empty / too-long / compose-unavailable / compose-failed —
// and abuse is handled by the shared rate-limit ceilings in infra/main.cpp, not here.
class ComposeApi {
public:
  explicit ComposeApi(std::shared_ptr<PlanComposer> composer);

  void compose(const drogon::HttpRequestPtr& req, HttpCallback&& callback);  // POST /v1/compose

private:
  std::shared_ptr<PlanComposer> composer_;
};

}
