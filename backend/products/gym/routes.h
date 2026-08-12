#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/AskService.h"
#include "products/gym/application/LogService.h"

#include <drogon/HttpAppFramework.h>

#include <memory>

namespace wm::gym {

// Everything the gym product's routes need, built once in main.cpp and handed across the seam —
// the same shape roadmap and journal use, in its own namespace so the three registerRoutes never
// collide. One service, one auth seam, nothing mailed.
//
// This is the HTTP half of the product and not the whole of it: `adapters/mcp/GymTools` is the
// second seam, registered as a `ToolModule` on the shared MCP host, and it holds the SAME
// LogService this struct carries. One core, two doors — so a rule cannot be true on one surface and
// not the other, and neither door needs to know the other exists.
//
// `askService` is the ONE nullable field, and null is the shipped default. It is Ask — the in-app
// chat in front of those same tools — and it needs a vendor key nobody is obliged to set, so a
// deployment without one gets a null here and the route below is never registered at all. That is the
// stance every vendor-backed feature in this repo takes: dark means absent, never a button that
// answers 503.
struct GymDeps {
  std::shared_ptr<LogService> logService;
  std::shared_ptr<AuthService> authService;
  std::shared_ptr<AskService> askService;  // null (or unconfigured) ⇒ no /v1/gym/ask route exists
  std::string appBaseUrl;                  // the browser app's origin — a coach share's link
};

// Mounts the gym product on the shared app: every /v1/gym/* route. All of them are owner-scoped
// except `GET /v1/gym/shared/{token}`, the coach share's read, where the token in the path is the
// whole credential. main.cpp calls this beside the roadmap and journal mounts.
void registerRoutes(drogon::HttpAppFramework& app, const GymDeps& deps);

}
