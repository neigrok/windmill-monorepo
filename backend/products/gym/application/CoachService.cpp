#include "products/gym/application/CoachService.h"

#include <algorithm>
#include <optional>
#include <utility>

namespace wm::gym {

CoachTools::CoachTools(ToolHost& inner, SessionId session)
    : inner_(inner), session_(std::move(session)) {}

std::vector<ToolDeclaration> CoachTools::declareTools() const {
  std::vector<ToolDeclaration> reads;
  for (ToolDeclaration& declaration : inner_.declareTools())
    if (declaration.access == Access::read) reads.push_back(std::move(declaration));
  return reads;
}

ToolResult CoachTools::callTool(const std::string& name, const Json::Value& arguments,
                                const ToolCaller& caller) {
  std::optional<ToolDeclaration> declared;
  for (ToolDeclaration& candidate : inner_.declareTools())
    if (candidate.name() == name) declared = std::move(candidate);

  if (!declared)
    return ToolResult::failure(name + ": no such tool — call tools/list for what this panel may do.");
  if (declared->access != Access::read)
    return ToolResult::failure(name +
                               ": this panel reads the log and never changes it, so it cannot run "
                               "this tool. The lifter does that themselves.");

  // The one workout, forced. A tool that names a session gets THIS session whatever was asked for,
  // so the panel stays about the workout it was opened on.
  Json::Value pinned = arguments.isObject() ? arguments : Json::Value(Json::objectValue);
  if (declared->descriptor["inputSchema"]["properties"].isMember("sessionId"))
    pinned["sessionId"] = session_.str();

  return inner_.callTool(name, pinned, caller);
}

CoachService::CoachService(LogService& log, CoachAgent& agent, ToolHost& gymTools,
                           Entitlements& entitlements)
    : log_(log), agent_(agent), gymTools_(gymTools), entitlements_(entitlements) {
  workers_.start();
}

bool CoachService::configured() const { return agent_.configured(); }

void CoachService::ask(const UserId& caller, const std::string& email, const SessionId& session,
                       std::vector<CoachTurn> turns, std::function<void(CoachReply)> done) {
  // The refusal ladder, cheapest first and every rung of it before any spend.
  if (turns.empty() || !turns.front().fromLifter || !turns.back().fromLifter) {
    done(CoachReply{CoachRefusal::turnsMalformed, {}});
    return;
  }
  for (std::size_t index = 1; index < turns.size(); ++index) {
    if (turns[index].fromLifter == turns[index - 1].fromLifter) {
      done(CoachReply{CoachRefusal::turnsMalformed, {}});
      return;
    }
  }
  if (turns.size() > kMaxCoachTurns) {
    done(CoachReply{CoachRefusal::tooManyTurns, {}});
    return;
  }
  if (turns.back().text.find_first_not_of(" \t\r\n") == std::string::npos) {
    done(CoachReply{CoachRefusal::questionEmpty, {}});
    return;
  }
  if (std::any_of(turns.begin(), turns.end(), [](const CoachTurn& turn) {
        return turn.text.size() > kMaxCoachTurnBytes;
      })) {
    done(CoachReply{CoachRefusal::questionTooLong, {}});
    return;
  }
  if (!agent_.configured()) {
    done(CoachReply{CoachRefusal::notConfigured, {}});
    return;
  }
  // The entitlement is read BEFORE the question is touched — a non-subscriber's words never reach the
  // vendor, and we never spend on an unpaid ask. The same predicate journal's Talk reads.
  if (!entitlements_.hasWindmillOne(caller, email)) {
    done(CoachReply{CoachRefusal::notEntitled, {}});
    return;
  }
  if (!perAccount_.allow(caller.str())) {
    done(CoachReply{CoachRefusal::rateLimited, {}});
    return;
  }
  // Ownership, settled here rather than left to the loop: absent and another account's are one fact,
  // and a workout this account cannot read is not a panel to open.
  if (!log_.detail(caller, session)) {
    done(CoachReply{CoachRefusal::unknownSession, {}});
    return;
  }

  workers_.getNextLoop()->queueInLoop(
      [this, caller, session, turns = std::move(turns), done = std::move(done)]() mutable {
        // THE GRANT, SAID OUT LOUD AT THE CALL SITE. The panel acts as the signed-in account, so the
        // widest thing it could inherit is everything that account may do — which for a question
        // about a workout that already happened is nine tools too many. It gets gym, read, and
        // nothing else; the catalog CoachTools then hands the model is that grant made visible.
        const ToolCaller actor{caller, ToolScope({{"gym", Access::read}})};
        CoachTools hands(gymTools_, session);
        done(CoachReply{CoachRefusal::none, agent_.answer(session, turns, actor, hands)});
      });
}

}
