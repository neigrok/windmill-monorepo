#pragma once

#include "platform/application/AuthService.h"
#include "products/gym/application/AskService.h"
#include "products/gym/ports/CatalogRepository.h"
#include "products/gym/ports/NotesRepository.h"
#include "products/gym/ports/ProgramRepository.h"
#include "products/gym/application/ThreadService.h"
#include "products/gym/application/TrainingService.h"
#include "products/gym/ports/BodyweightRepository.h"
#include "products/gym/ports/PreferencesRepository.h"

#include <drogon/HttpAppFramework.h>

#include <memory>
#include <functional>

namespace wm::gym {

// The HTTP collaborators, built once in main.cpp. Reads use repositories or the services that derive
// their answers; imports use the same write door GymTools and Coach use.
// AskService remains available for durable Stop/recovery; new asks are mounted only with a vendor key.
struct GymDeps {
  std::shared_ptr<TrainingService> trainingService;
  std::shared_ptr<GymWriteDoor> door;
  std::shared_ptr<CatalogRepository> catalog;
  std::shared_ptr<ProgramRepository> program;
  std::shared_ptr<ThreadService> threadService;
  std::shared_ptr<NotesRepository> notes;
  std::shared_ptr<PreferencesRepository> preferences;
  std::shared_ptr<BodyweightRepository> bodyweight;
  std::shared_ptr<AuthService> authService;
  std::shared_ptr<AskService> askService;  // null (or unconfigured) ⇒ no /v1/gym/ask route exists
  std::string appBaseUrl;                  // the browser app's origin — a workout share's link
  std::function<void(std::function<void()>)> onShutdown;
};

// Mounts the gym product on the shared app: every /v1/gym/* route. All of them are owner-scoped
// except `GET /v1/gym/shared/{token}`, the workout share's read, where the token in the path is the
// whole credential. main.cpp calls this beside the roadmap and journal mounts.
void registerRoutes(drogon::HttpAppFramework& app, const GymDeps& deps);

}
