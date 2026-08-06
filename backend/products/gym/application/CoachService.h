#pragma once

#include "platform/adapters/http/RateLimiter.h"
#include "platform/application/Entitlements.h"
#include "platform/domain/Ids.h"
#include "platform/ports/ToolHost.h"
#include "products/gym/application/LogService.h"
#include "products/gym/ports/CoachAgent.h"

#include <trantor/net/EventLoopThreadPool.h>

#include <cstddef>
#include <functional>
#include <string>
#include <vector>

namespace wm::gym {

// THE PANEL'S HANDS, AND THE NARROWING THAT MAKES THEM SAFE TO HAND A MODEL. Gym's tool host does not
// gate — by design, because over MCP the grant was already settled above it by CompositeToolHost — so
// a panel wired straight to it would be a door with no lock, and a hallucinated `discard_session`
// would execute. This is that lock, and it is gym's twin of roadmap's ScopedToolHost:
//
//   1. READ ONLY. Every declaration carries its own access level, so this refuses by reading the
//      catalog rather than by keeping a list of names that could drift from it. Nine of gym's fifteen
//      tools are simply not here, and naming one is refused rather than run.
//   2. ONE WORKOUT. Every tool that takes a `sessionId` has it FORCED to the session the panel was
//      opened on, so a set note somebody typed can never redirect the panel onto another workout.
//
// The two layers stack rather than merge, exactly as they do for a tend: the ToolScope handed at the
// call site says how far the CREDENTIAL reaches, this says what the RUN was asked to do. Either alone
// would be enough today. Both is what survives someone widening the other by accident.
class CoachTools : public ToolHost {
public:
  CoachTools(ToolHost& inner, SessionId session);

  std::vector<ToolDeclaration> declareTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller) override;

private:
  ToolHost& inner_;
  SessionId session_;
};

// Why an ask did not reach the model, as facts the HTTP edge maps to statuses. Every one of these is
// settled BEFORE a single token is spent, which is the whole point of the ordering: a lifter without
// Windmill One never has their question sent anywhere, and neither does a malformed thread.
enum class CoachRefusal {
  none,
  turnsMalformed,   // not a conversation: empty, not alternating, or not ending on the lifter
  questionEmpty,
  questionTooLong,
  tooManyTurns,
  notConfigured,    // no vendor key — in production the route is absent, so this is the fail-closed floor
  notEntitled,      // the connected log is Windmill One
  rateLimited,
  unknownSession,   // absent, or another account's — one fact, as everywhere else in gym
};

struct CoachReply {
  CoachRefusal refusal = CoachRefusal::none;
  CoachAnswer answer;  // meaningful only when refusal == none
};

// What a thread may weigh. A panel about one workout that needs more than six turns or a thousand
// bytes a turn is not a panel about one workout any more, and the caps are also what keeps a
// stateless server's request body from becoming an unbounded prompt somebody else pays for.
constexpr std::size_t kMaxCoachTurns = 8;
constexpr std::size_t kMaxCoachTurnBytes = 1000;

// The panel, from the request's point of view: refuse everything refusable, then run the loop on a
// thread of this service's own and answer when it settles.
//
// THE WORKER POOL IS NOT AN OPTIMISATION. `CoachAgent::answer` blocks for as long as the vendor takes,
// and this process serves every product from a handful of request loops — running the loop on the
// handler's thread would park one of them for a minute and stop the training log answering anybody.
// So the handler hands its callback over and returns; `done` fires on a worker.
class CoachService {
public:
  CoachService(LogService& log, CoachAgent& agent, ToolHost& gymTools, Entitlements& entitlements);

  // Whether this deployment can answer at all. main.cpp reads it to decide whether the route exists:
  // a button that answers 503 is worse than a panel that was never drawn.
  bool configured() const;

  void ask(const UserId& caller, const std::string& email, const SessionId& session,
           std::vector<CoachTurn> turns, std::function<void(CoachReply)> done);

private:
  LogService& log_;
  CoachAgent& agent_;
  ToolHost& gymTools_;
  Entitlements& entitlements_;
  // Per ACCOUNT, not per IP: the spend is the account's and a household behind one address should not
  // share a budget. ~6 questions per ten minutes, three of them back to back.
  RateLimiter perAccount_{6.0 / 600.0, 3.0};
  trantor::EventLoopThreadPool workers_{2};
};

}
