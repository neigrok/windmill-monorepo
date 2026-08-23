#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/Entitlements.h"
#include "products/journal/application/EchoExplain.h"
#include "products/journal/application/EchoSweep.h"
#include "products/journal/application/NudgeSweep.h"
#include "products/journal/application/PageService.h"
#include "products/journal/ports/EchoRepository.h"
#include "products/journal/ports/NudgeRepository.h"
#include "products/journal/ports/Transcriber.h"

#include <drogon/HttpAppFramework.h>

#include <memory>
#include <string>

namespace wm::journal {

// Built once in main.cpp; its own namespace keeps the registerRoutes overloads from colliding.
struct JournalDeps {
  std::shared_ptr<PageService> pageService;
  std::shared_ptr<AuthService> authService;
  std::shared_ptr<NudgeRepository> nudges;
  std::shared_ptr<NudgeSweep> nudgeSweep;
  std::shared_ptr<TokenGenerator> tokens;
  std::shared_ptr<Clock> clock;
  std::string nudgeAdminToken;
  std::shared_ptr<EchoRepository> echoes;
  std::shared_ptr<EchoSweep> echoSweep;
  std::shared_ptr<EchoExplainer> echoExplainer;
  std::string echoAdminToken;
  std::shared_ptr<Transcriber> transcriber;
  std::shared_ptr<Entitlements> entitlements;
};

// Mounts every /v1/journal/* route, owner-scoped, with no public surface.
void registerRoutes(drogon::HttpAppFramework& app, const JournalDeps& deps);

}
