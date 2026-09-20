#pragma once

#include "platform/application/AuthService.h"
#include "platform/ports/Clock.h"
#include "products/gym/application/AskService.h"
#include "products/gym/application/BodyweightService.h"
#include "products/gym/application/CatalogService.h"
#include "products/gym/application/NotesService.h"
#include "products/gym/application/PreferencesService.h"
#include "products/gym/application/ProgramService.h"
#include "products/gym/application/ThreadService.h"
#include "products/gym/application/TrainingService.h"

#include <drogon/HttpAppFramework.h>

#include <memory>

namespace wm::gym {

// Everything the gym product's routes need, built once in main.cpp and handed across the seam —
// the same shape roadmap and journal use, in its own namespace so the three registerRoutes never
// collide. Seven services — one per aggregate port, and each adapter below takes only the ones it
// reads — one auth seam, the clock (read by `BodyweightApi` alone, for the forecast gate), nothing
// mailed.
//
// This is the HTTP half of the product and not the whole of it: `adapters/mcp/GymTools` is the
// second seam, registered as a `ToolModule` on the shared MCP host, and it holds the SAME
// TrainingService, CatalogService, ProgramService, NotesService and BodyweightService this struct
// carries. One core, two doors — so a rule cannot be true on one surface and not the other, and
// neither door needs to know the other exists.
//
// AskService remains available for durable Stop/recovery; new asks are mounted only with a vendor key.
struct GymDeps {
  std::shared_ptr<TrainingService> trainingService;
  std::shared_ptr<CatalogService> catalogService;
  std::shared_ptr<ProgramService> programService;
  std::shared_ptr<PreferencesService> preferencesService;
  std::shared_ptr<ThreadService> threadService;
  std::shared_ptr<NotesService> notesService;
  std::shared_ptr<BodyweightService> bodyweightService;
  std::shared_ptr<AuthService> authService;
  std::shared_ptr<Clock> clock;
  std::shared_ptr<AskService> askService;  // null (or unconfigured) ⇒ no /v1/gym/ask route exists
  std::string appBaseUrl;                  // the browser app's origin — a workout share's link
};

// Mounts the gym product on the shared app: every /v1/gym/* route. All of them are owner-scoped
// except `GET /v1/gym/shared/{token}`, the workout share's read, where the token in the path is the
// whole credential. main.cpp calls this beside the roadmap and journal mounts.
void registerRoutes(drogon::HttpAppFramework& app, const GymDeps& deps);

}
