#pragma once

#include "platform/application/AuthService.h"
#include "products/journal/application/PageService.h"

#include <drogon/HttpAppFramework.h>

#include <memory>

namespace wm::journal {

// Everything the journal product's routes need, built once in main.cpp and handed across the seam —
// the same shape roadmap uses (products/roadmap/routes.h), in its own namespace so the two
// registerRoutes overloads never collide. Wave 1 is the pages canvas; nudges/echoes/voice add their
// own collaborators here as later waves land.
struct JournalDeps {
  std::shared_ptr<PageService> pageService;
  std::shared_ptr<AuthService> authService;
};

// Mounts the journal product on the shared app: every /v1/journal/* route, owner-scoped, no public
// surface. main.cpp calls this beside wm::registerRoutes(app, roadmapDeps).
void registerRoutes(drogon::HttpAppFramework& app, const JournalDeps& deps);

}
