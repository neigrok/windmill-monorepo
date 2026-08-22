#pragma once

#include "platform/application/AuthService.h"
#include "platform/ports/Clock.h"
#include "platform/ports/TokenGenerator.h"
#include "products/roadmap/adapters/ws/PresenceHub.h"
#include "products/roadmap/adapters/ws/WsPresenceBus.h"
#include "products/roadmap/application/ForkService.h"
#include "products/roadmap/application/ProgressService.h"
#include "products/roadmap/application/ReminderSweep.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/application/TendingService.h"
#include "products/roadmap/application/TreeRegistry.h"
#include "products/roadmap/domain/Ids.h"
#include "products/roadmap/ports/OgImageRepository.h"
#include "products/roadmap/ports/OgVideoRepository.h"
#include "products/roadmap/ports/OpLog.h"
#include "products/roadmap/ports/PlanComposer.h"
#include "products/roadmap/ports/ProgressRepository.h"
#include "products/roadmap/ports/ReminderRepository.h"
#include "products/roadmap/ports/TreeRepository.h"

#include <drogon/HttpAppFramework.h>

#include <memory>
#include <set>
#include <string>

namespace wm {

// Everything the roadmap product's routes need, built once in main.cpp and handed across the seam.
// These are the same collaborators the flat router constructed inline; bundling them here is what
// lets a future product mirror the shape (its own Deps, its own registerRoutes) without main.cpp
// growing a second flat router.
struct RoadmapDeps {
  std::shared_ptr<RoomRegistry> registry;
  std::shared_ptr<TreeRepository> trees;
  std::shared_ptr<ProgressRepository> progress;
  std::shared_ptr<ProgressService> progressService;
  std::shared_ptr<OpLog> oplog;
  std::shared_ptr<WsPresenceBus> bus;
  std::shared_ptr<PresenceHub> presence;
  Hlc genesis;
  std::shared_ptr<AuthService> authService;
  std::shared_ptr<ForkService> forkService;
  std::shared_ptr<TreeRegistry> treeRegistry;
  std::shared_ptr<OgImageRepository> ogImages;
  std::shared_ptr<OgVideoRepository> ogVideos;
  std::string webRoot;
  std::shared_ptr<TendingService> tendingService;
  std::shared_ptr<ReminderSweep> reminderSweep;
  std::shared_ptr<ReminderRepository> reminderRepo;
  std::shared_ptr<TokenGenerator> tokens;
  std::shared_ptr<Clock> clock;
  std::string remindersAdminToken;
  std::shared_ptr<PlanComposer> composer;
  // The origins allowed to drive this server from a browser — main.cpp composes the set once, for
  // CORS, and the collab socket gates its upgrade on the same one. Two lists would drift.
  std::set<std::string> allowedOrigins;
};

// Mounts the roadmap product on the shared app: the collab socket, its presence flush, and every
// roadmap HTTP route (/v1/trees*, /gallery, /t/:id, /v1/reminders*, /v1/tend*, /v1/compose, …).
void registerRoutes(drogon::HttpAppFramework& app, const RoadmapDeps& deps);

}
