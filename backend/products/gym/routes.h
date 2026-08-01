#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/LogService.h"

#include <drogon/HttpAppFramework.h>

#include <memory>

namespace wm::gym {

// Everything the gym product's routes need, built once in main.cpp and handed across the seam —
// the same shape roadmap and journal use, in its own namespace so the three registerRoutes never
// collide. Phase 0 is the durable log: one service, one auth seam, nothing armed, nothing mailed.
struct GymDeps {
  std::shared_ptr<LogService> logService;
  std::shared_ptr<AuthService> authService;
};

// Mounts the gym product on the shared app: every /v1/gym/* route, owner-scoped, no public
// surface. main.cpp calls this beside the roadmap and journal mounts.
void registerRoutes(drogon::HttpAppFramework& app, const GymDeps& deps);

}
