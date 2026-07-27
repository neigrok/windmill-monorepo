#pragma once

#include "platform/application/AuthService.h"
#include "products/journal/application/NudgeSweep.h"
#include "products/journal/application/PageService.h"
#include "products/journal/ports/NudgeRepository.h"

#include <drogon/HttpAppFramework.h>

#include <memory>
#include <string>

namespace wm::journal {

// Everything the journal product's routes need, built once in main.cpp and handed across the seam —
// the same shape roadmap uses (products/roadmap/routes.h), in its own namespace so the two
// registerRoutes overloads never collide. Wave 1 is the pages canvas; Wave 2 adds the nudge control
// surface + its heartbeat; echoes/voice add their own collaborators as later waves land.
struct JournalDeps {
  std::shared_ptr<PageService> pageService;
  std::shared_ptr<AuthService> authService;
  std::shared_ptr<NudgeRepository> nudges;
  std::shared_ptr<NudgeSweep> nudgeSweep;
  std::shared_ptr<TokenGenerator> tokens;
  std::shared_ptr<Clock> clock;
  std::string nudgeAdminToken;
};

// Mounts the journal product on the shared app: every /v1/journal/* route, owner-scoped, no public
// surface. main.cpp calls this beside wm::registerRoutes(app, roadmapDeps).
void registerRoutes(drogon::HttpAppFramework& app, const JournalDeps& deps);

}
