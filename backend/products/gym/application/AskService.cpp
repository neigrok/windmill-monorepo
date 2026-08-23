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

// The properties a tool publishes, comma-joined, for a refusal message.
std::string declaredArguments(const Json::Value& inputSchema) {
  std::string declared;
  for (const std::string& property : inputSchema["properties"].getMemberNames()) {
    if (!declared.empty()) declared += ", ";
    declared += property;
  }
  return declared.empty() ? "no arguments" : declared;
}

// Every gym tool publishes `additionalProperties: false`. Ask does not pass through
// CompositeToolHost, so the check is repeated here word for word and refuses identically.
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

// After this long idle any bucket is full whatever it held, so it can be forgotten.
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

AskTools::AskTools(GymTools& inner, ThreadId thread)
    : inner_(inner), thread_(std::move(thread)) {}

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

  if (!declared) {
    // A name gym retired answers with what replaced it, on this door as over MCP.
    if (std::optional<ToolRetirement> retired = inner_.retirement(name))
      return ToolResult::failure(name + ": " + retired->sentence);
    return ToolResult::failure(name + ": no such tool — call tools/list for what Ask may do.");
  }
  if (declared->access != Access::read && !mintsProposal(name))
    // Asked FIRST, before the grant below, so a tool this door never offers answers the same at
    // every grant.
    return ToolResult::failure(name +
                               ": Ask reads the log and proposes; it cannot change what a lifter "
                               "logged. Tell them that one is theirs to change, and name the workout "
                               "and the movement so they can find it.");
  // The grant, checked where the CALL is and not only where the catalog is.
  if (!caller.scope.allows(declared->product, declared->access))
    return ToolResult::failure(name + ": this connection was not granted " + declared->product + ":" +
                               toString(declared->access) + ", so it cannot run this tool.");
  if (std::optional<std::string> unknown =
          unknownArgument(declared->descriptor["inputSchema"], arguments))
    return ToolResult::failure(name + ": " + *unknown);

  const ToolResult outcome = inner_.callTool(
      name, arguments, caller, ProposalSource{ProposalDoor::ask, "", "", thread_}, read_);
  // The id is taken off the tool's own reply rather than out of the answer's prose.
  if (!outcome.isError && outcome.payload["proposal"]["id"].isString())
    proposals_.push_back(outcome.payload["proposal"]["id"].asString());
  return outcome;
}

AskService::AskService(TrainingService& training, ThreadService& threads, AskAgent& agent,
                       GymTools& gymTools, Entitlements& entitlements)
    : training_(training), threads_(threads), agent_(agent), gymTools_(gymTools), entitlements_(entitlements) {
  workers_.start();
}

bool AskService::configured() const { return agent_.configured(); }

void AskService::ask(const UserId& caller, const std::string& email, const ThreadId& thread,
                     std::string question, std::function<void(AskReply)> done) {
  // The refusal ladder, every rung of it before any spend.
  if (!wellFormedId(thread.str())) {
    done(AskReply{AskRefusal::threadMalformed});
    return;
  }
  if (question.find_first_not_of(" \t\r\n") == std::string::npos) {
    done(AskReply{AskRefusal::questionEmpty});
    return;
  }
  if (question.size() > kMaxAskTurnBytes) {
    done(AskReply{AskRefusal::questionTooLong});
    return;
  }
  // A NUL stops a `text` column, and non-UTF-8 bytes are refused by Postgres mid-transaction;
  // `openThread` runs outside this method's only try, so that would leave as a retryable 500 on a
  // body that can never land. Both are wire-reachable through jsoncpp escapes.
  if (!storableText(question)) {
    done(AskReply{AskRefusal::questionUnstorable});
    return;
  }
  if (!agent_.configured()) {
    done(AskReply{AskRefusal::notConfigured});
    return;
  }
  // Never mid-session, enforced here rather than in three clients, and above the ceilings so a
  // lifter between sets hears that first. The read settles a stale workout on its way past.
  if (training_.openSession(caller)) {
    done(AskReply{AskRefusal::sessionOpen});
    return;
  }
  // Our dollar ceiling over the trailing window, read before a token is spent.
  if (!entitlements_.aiAllowanceFor(caller, email).allows()) {
    done(AskReply{AskRefusal::outOfBudget});
    return;
  }
  // Opened BEFORE the model runs, because a proposal minted mid-conversation points at the row. A
  // run that never answers is undone below by `discardEmptyThread`. The title is this question,
  // verbatim, and only on a thread that did not exist.
  const ThreadOpenOutcome opened = threads_.openThread(caller, thread, question);
  if (opened.error == ThreadOpenError::idTaken || !opened.thread) {
    // No thread and no named error is the two-accounts-one-id race: read it as an id somebody else
    // holds.
    done(AskReply{AskRefusal::threadTaken});
    return;
  }
  std::vector<AskTurn> turns;
  for (const ThreadTurn& said : opened.thread->turns)
    turns.push_back(AskTurn{said.fromLifter, said.text});
  // The pair this ask would add — the question and the answer to come — has to fit under the cap
  // with everything already said.
  if (turns.size() + 2 > kMaxThreadTurns) {
    threads_.discardEmptyThread(caller, thread);
    done(AskReply{AskRefusal::tooManyTurns});
    return;
  }
  turns.push_back(AskTurn{true, question});
  // Taken LAST, after every refusal above it, so a refusal costs nothing.
  if (!perAccount_.take(caller.str())) {
    threads_.discardEmptyThread(caller, thread);
    done(AskReply{AskRefusal::dailyLimit});
    return;
  }

  workers_.getNextLoop()->queueInLoop(
      [this, caller, thread, turns = std::move(turns), done = std::move(done)]() mutable {
        // The three levels are named one by one rather than taken as `everything()`, so a fourth
        // level or a second product never rides along. AskTools reads this scope.
        const ToolCaller actor{caller, ToolScope({{"gym", Access::read},
                                                  {"gym", Access::write},
                                                  {"gym", Access::del}})};
        AskTools hands(gymTools_, thread);
        AskReply reply;
        try {
          reply.answer = agent_.answer(turns, actor, hands);
        } catch (const std::bad_alloc&) {
          throw;  // not an answer that failed: an exhausted process must die loudly (GymTools.cpp)
        } catch (const std::exception& failed) {
          // Nothing sits above a worker loop: an exception leaving this lambda takes the process
          // down.
          LOG_ERROR << "gym ask run threw: " << failed.what();
          reply.answer = AskAnswer{false, "", failed.what(), {}};
        }
        // The test is whether the run COST anything, never whether it answered: `modelTurns == 0`
        // gives the question back. A failure that spent turns is charged. A run that THREW is given
        // back whatever it spent, the count having died with the stack.
        if (reply.answer.modelTurns == 0) perAccount_.giveBack(caller.str());
        reply.read = hands.read().tally();
        reply.proposals = hands.proposals();
        // The conversation is written only once it has an answer, both halves together, so a failed
        // ask leaves the thread as it found it. A proposal the dead run minted keeps its row and
        // loses its thread link.
        if (!reply.answer.ok) {
          threads_.discardEmptyThread(caller, thread);
          done(std::move(reply));
          return;
        }
        threads_.appendTurns(caller, thread, {ThreadTurn{true, turns.back().text},
                                          ThreadTurn{false, reply.answer.answer}});
        done(std::move(reply));
      });
}

}
