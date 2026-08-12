#include "products/gym/application/AskService.h"

#include "products/gym/adapters/mcp/GymToolCatalog.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <cstddef>
#include <exception>
#include <new>
#include <optional>
#include <utility>

namespace wm::gym {

namespace {

// The properties a tool publishes, comma-joined — what a refusal offers instead of the key it just
// rejected. An agent cannot look up an example between two calls the way a person reading docs can,
// so a refusal that names only the mistake costs a whole round trip.
std::string declaredArguments(const Json::Value& inputSchema) {
  std::string declared;
  for (const std::string& property : inputSchema["properties"].getMemberNames()) {
    if (!declared.empty()) declared += ", ";
    declared += property;
  }
  return declared.empty() ? "no arguments" : declared;
}

// EVERY GYM TOOL PUBLISHES `additionalProperties: false`, AND ASK'S DOOR KEEPS THAT PROMISE TOO.
// Over MCP the check belongs to CompositeToolHost, the gate above every module; Ask does not pass
// through it, so without this the same call answered differently on the two doors — `get_stats
// {"exerciseID": …}` was refused by name on one and silently WIDENED on the other, handing back
// every movement the lifter has ever trained while the model believed it had asked about one. §2
// says the doors differ in transport, prompt and who pays; a looser contract is not on that list.
//
// It is the composite's sentence word for word, because parity IS the fix, and it is written twice
// because that check lives in an anonymous namespace inside platform's MCP adapter, which this
// wave's territory does not reach. The REQUEST beside this wave is to hang it off ToolDeclaration,
// where both doors would read the one copy.
std::optional<std::string> unknownArgument(const Json::Value& inputSchema,
                                           const Json::Value& arguments) {
  if (!arguments.isObject()) return std::nullopt;  // the host answers a wrong-shape body, naming its type
  const Json::Value& properties = inputSchema["properties"];
  for (const std::string& key : arguments.getMemberNames()) {
    if (properties.isMember(key)) continue;
    return "unknown argument \"" + key + "\". This tool takes: " + declaredArguments(inputSchema) + ".";
  }
  return std::nullopt;
}

// A question refills over the day at this rate, and after this long idle any bucket is full whatever
// it held — which is exactly when it can be forgotten, because a full bucket and an account that has
// never asked answer identically. That is what keeps the table bounded without changing an answer.
constexpr double kQuestionsPerSecond = kAskPerDay / 86400.0;
constexpr double kRefilledSeconds = kAskBackToBack / kQuestionsPerSecond;
constexpr std::size_t kMaxAccountsHeld = 100000;

}  // namespace

bool AskRation::take(const std::string& account) {
  const std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> holding(mutex_);
  if (held_.size() > kMaxAccountsHeld) {
    for (auto entry = held_.begin(); entry != held_.end();) {
      const double idle = std::chrono::duration<double>(now - entry->second.refilledAt).count();
      if (idle >= kRefilledSeconds)
        entry = held_.erase(entry);
      else
        ++entry;
    }
  }

  Held& ration = held_[account];
  if (ration.refilledAt != std::chrono::steady_clock::time_point{}) {
    const double elapsed = std::chrono::duration<double>(now - ration.refilledAt).count();
    ration.questions = std::min(kAskBackToBack, ration.questions + elapsed * kQuestionsPerSecond);
  }
  ration.refilledAt = now;
  if (ration.questions < 1.0) return false;
  ration.questions -= 1.0;
  return true;
}

void AskRation::giveBack(const std::string& account) {
  std::lock_guard<std::mutex> holding(mutex_);
  const auto ration = held_.find(account);
  if (ration == held_.end()) return;
  ration->second.questions = std::min(kAskBackToBack, ration->second.questions + 1.0);
}

AskTools::AskTools(GymTools& inner) : inner_(inner) {}

std::vector<ToolDeclaration> AskTools::declareTools() const {
  std::vector<ToolDeclaration> offered;
  for (ToolDeclaration& declaration : inner_.declareTools())
    if (declaration.access == Access::read || mintsProposal(declaration.name()))
      offered.push_back(std::move(declaration));
  return offered;
}

ToolResult AskTools::callTool(const std::string& name, const Json::Value& arguments,
                              const ToolCaller& caller) {
  std::optional<ToolDeclaration> declared;
  for (ToolDeclaration& candidate : inner_.declareTools())
    if (candidate.name() == name) declared = std::move(candidate);

  if (!declared)
    return ToolResult::failure(name + ": no such tool — call tools/list for what Ask may do.");
  if (declared->access != Access::read && !mintsProposal(name))
    // The sentence the model reads is the sentence the lifter reads back, because §L's refusal is
    // said out loud and hands the job over rather than failing quietly.
    return ToolResult::failure(name +
                               ": Ask reads the log and proposes; it cannot change what a lifter "
                               "logged. Tell them that one is theirs to change, and name the workout "
                               "and the movement so they can find it.");
  if (std::optional<std::string> unknown =
          unknownArgument(declared->descriptor["inputSchema"], arguments))
    return ToolResult::failure(name + ": " + *unknown);

  const ToolResult outcome = inner_.callTool(name, arguments, caller, ProposalDoor::ask, read_);
  // A proposal is an object the lifter has to be shown, so the id is taken off the tool's own reply
  // rather than out of the answer's prose — the model names it or not, and either way the app has it.
  if (!outcome.isError && outcome.payload["proposal"]["id"].isString())
    proposals_.push_back(outcome.payload["proposal"]["id"].asString());
  return outcome;
}

AskService::AskService(LogService& log, AskAgent& agent, GymTools& gymTools,
                       Entitlements& entitlements)
    : log_(log), agent_(agent), gymTools_(gymTools), entitlements_(entitlements) {
  workers_.start();
}

bool AskService::configured() const { return agent_.configured(); }

void AskService::ask(const UserId& caller, const std::string& email, std::vector<AskTurn> turns,
                     std::function<void(AskReply)> done) {
  // The refusal ladder, and every rung of it before any spend.
  if (turns.empty() || !turns.front().fromLifter || !turns.back().fromLifter) {
    done(AskReply{AskRefusal::turnsMalformed});
    return;
  }
  for (std::size_t index = 1; index < turns.size(); ++index) {
    if (turns[index].fromLifter == turns[index - 1].fromLifter) {
      done(AskReply{AskRefusal::turnsMalformed});
      return;
    }
  }
  if (turns.size() > kMaxAskTurns) {
    done(AskReply{AskRefusal::tooManyTurns});
    return;
  }
  if (turns.back().text.find_first_not_of(" \t\r\n") == std::string::npos) {
    done(AskReply{AskRefusal::questionEmpty});
    return;
  }
  if (std::any_of(turns.begin(), turns.end(),
                  [](const AskTurn& turn) { return turn.text.size() > kMaxAskTurnBytes; })) {
    done(AskReply{AskRefusal::questionTooLong});
    return;
  }
  if (!agent_.configured()) {
    done(AskReply{AskRefusal::notConfigured});
    return;
  }
  // NEVER MID-SESSION, ENFORCED HERE. §L says Ask is not offered while a workout is running, and
  // three clients each remembering that is not a rule — it is three chances to forget. It sits above
  // the ceilings because it is a fact about WHEN Ask exists at all: a lifter between sets should hear
  // that, not something about the day's questions. The read settles a stale workout on its way past,
  // so a session somebody walked away from yesterday does not hold Ask shut for good.
  if (log_.openSession(caller)) {
    done(AskReply{AskRefusal::sessionOpen});
    return;
  }
  // OUR dollar ceiling over the trailing window, read while everything is still refusable and before
  // a token is spent. `aiAllowanceFor` is also where the One gate returns when checkout opens: it
  // already reads the plan to pick the ceiling, so arming the gate is a `hasWindmillOne` refusal on
  // this line and nothing else moves.
  if (!entitlements_.aiAllowanceFor(caller, email).allows()) {
    done(AskReply{AskRefusal::outOfBudget});
    return;
  }
  // THE DAY'S QUESTION, TAKEN LAST — after every refusal above it, because a refusal answered
  // nothing and must therefore cost nothing. A lifter turned away mid-workout, or held at our own
  // ceiling, walks out with the day's questions intact.
  if (!perAccount_.take(caller.str())) {
    done(AskReply{AskRefusal::dailyLimit});
    return;
  }

  workers_.getNextLoop()->queueInLoop(
      [this, caller, turns = std::move(turns), done = std::move(done)]() mutable {
        // THE GRANT, SAID OUT LOUD AT THE CALL SITE. Ask acts as the signed-in account, and the three
        // levels are named one by one rather than taken as `everything()` — so a fourth level, or a
        // second product, never rides along on a token nobody widened. What the model actually SEES
        // is narrower still: AskTools hands it the reads and the two proposal mints, and the levels
        // here are only what lets those two through the catalog filter.
        const ToolCaller actor{caller, ToolScope({{"gym", Access::read},
                                                  {"gym", Access::write},
                                                  {"gym", Access::del}})};
        AskTools hands(gymTools_);
        AskReply reply;
        try {
          reply.answer = agent_.answer(turns, actor, hands);
        } catch (const std::bad_alloc&) {
          throw;  // not an answer that failed: an exhausted process must die loudly (GymTools.cpp)
        } catch (const std::exception& failed) {
          // NOTHING SITS ABOVE A WORKER LOOP. An exception that leaves this lambda is not a failed
          // question, it is the whole process — every product on this box — gone, with the lifter's
          // request never answered either. The vendor edge is the one place a document nobody here
          // wrote is walked (a reply shaped unlike the one the loop reads), and every diagnostic is
          // the same fact to the lifter anyway: nothing came back.
          LOG_ERROR << "gym ask run threw: " << failed.what();
          reply.answer = AskAnswer{false, "", failed.what(), {}};
        }
        // A RUN THAT NEVER ANSWERED IS NOT ONE OF THE DAY'S QUESTIONS. `ok` false is a dead upstream,
        // an early stop, a cap hit mid-loop — the lifter reads "Ask didn't answer" (AskApi.cpp) and
        // has nothing. Charging them for it would make the cap's own copy false: three outages in a
        // row used to leave a lifter with zero answers and the sentence that they had used the day.
        if (!reply.answer.ok) perAccount_.giveBack(caller.str());
        reply.read = hands.read().tally();
        reply.proposals = hands.proposals();
        done(std::move(reply));
      });
}

}
