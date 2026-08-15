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
    // The sentence the model reads is the sentence the lifter reads back, because §L's refusal is
    // said out loud and hands the job over rather than failing quietly. It is asked FIRST, before the
    // grant below, so what Ask refuses is answered with Ask's own sentence at every grant there is —
    // a tool this door never offers is never a story about levels.
    return ToolResult::failure(name +
                               ": Ask reads the log and proposes; it cannot change what a lifter "
                               "logged. Tell them that one is theirs to change, and name the workout "
                               "and the movement so they can find it.");
  // THE GRANT, CHECKED WHERE THE CALL IS AND NOT ONLY WHERE THE CATALOG IS. `listTools` has always
  // filtered by the caller's scope; this door executed without ever reading it, so the two halves of
  // one rule disagreed — narrow the scope and the tool vanished from the catalog while the call still
  // ran. Ask hands itself the full gym grant today, so nothing was reachable through the gap; what it
  // was, was a trap for the first person to narrow that scope, which is precisely what arming the One
  // gate or dropping `del` to take propose_routine_removal away would do. It is the composite's
  // sentence over MCP, said here for the door that does not pass through it.
  if (!caller.scope.allows(declared->product, declared->access))
    return ToolResult::failure(name + ": this connection was not granted " + declared->product + ":" +
                               toString(declared->access) + ", so it cannot run this tool.");
  if (std::optional<std::string> unknown =
          unknownArgument(declared->descriptor["inputSchema"], arguments))
    return ToolResult::failure(name + ": " + *unknown);

  const ToolResult outcome = inner_.callTool(
      name, arguments, caller, ProposalSource{ProposalDoor::ask, "", "", thread_}, read_);
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

void AskService::ask(const UserId& caller, const std::string& email, const ThreadId& thread,
                     std::string question, std::function<void(AskReply)> done) {
  // The refusal ladder, and every rung of it before any spend.
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
  // THE ONE TEXT RULE, WHICH THIS DOOR WAS THE ONLY FREE TEXT IN GYM TO SKIP. A note, a movement's
  // name and a routine's name all meet `storableText` at construction; a question had a length and a
  // blankness check and nothing else — and the question becomes a TITLE, which §O promises is the
  // lifter's words byte for byte. Both halves of that rule land here:
  //   · a NUL stops a `text` column, so the head of somebody's question stored as if it were the
  //     whole of it and the title was silently not what they typed.
  //   · bytes that are not well-formed UTF-8 (a lone surrogate half among them) are refused by
  //     Postgres MID-TRANSACTION, and `openThread` runs on the handler thread outside this method's
  //     only try — so it left as the house 500, the one status every client queue is told to RETRY,
  //     on a body that can never land.
  // Both are wire-reachable: jsoncpp decodes a \u0000 escape and a lone surrogate escape into
  // exactly these bytes and hands drogon the result, so neither needs a hostile client to produce.
  // The answer is the terminal 400 the rest of this module already gives.
  if (!storableText(question)) {
    done(AskReply{AskRefusal::questionUnstorable});
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
  // THE THREAD, OPENED BEFORE THE MODEL RUNS AND NOT AFTER IT — because a proposal minted halfway
  // through this conversation points at the row, so the row has to be there to point at. A run that
  // then never answers is undone below: `discardEmptyThread` takes back a thread that never got a
  // turn, which is the same rule the day's ration keeps when it gives a dead run its question back.
  //
  // The title is this question, VERBATIM, and only on a thread that did not exist. A thread is named
  // by how it opened; nothing here, and nothing behind here, ever writes a title a model composed.
  const ThreadOpenOutcome opened = log_.openThread(caller, thread, question);
  if (opened.error == ThreadOpenError::idTaken || !opened.thread) {
    // NO THREAD AND NO NAMED ERROR IS THE RACE, AND IT IS THE SAME ANSWER. Two accounts can mint one
    // id at once: the loser's global probe found the id free, its insert lost to `ON CONFLICT DO
    // NOTHING`, and its owner-scoped read back came home empty. That used to fall through as a FRESH
    // EMPTY conversation — the vendor call was made and billed, `appendTurns` found no row it could
    // lock and dropped both turns, and the lifter got a 200 whose answer was never stored beside a
    // thread that never appeared in the list. It is an id somebody else holds, however it was found
    // out, so it is refused here where a refusal still costs nothing.
    done(AskReply{AskRefusal::threadTaken});
    return;
  }
  std::vector<AskTurn> turns;
  for (const ThreadTurn& said : opened.thread->turns)
    turns.push_back(AskTurn{said.fromLifter, said.text});
  // The pair this ask would add — the question and the answer to come — has to fit under the cap
  // with everything already said, or the conversation would be capped halfway through answering.
  if (turns.size() + 2 > kMaxThreadTurns) {
    log_.discardEmptyThread(caller, thread);
    done(AskReply{AskRefusal::tooManyTurns});
    return;
  }
  turns.push_back(AskTurn{true, question});
  // THE DAY'S QUESTION, TAKEN LAST — after every refusal above it, because a refusal answered
  // nothing and must therefore cost nothing. A lifter turned away mid-workout, or held at our own
  // ceiling, walks out with the day's questions intact.
  if (!perAccount_.take(caller.str())) {
    log_.discardEmptyThread(caller, thread);
    done(AskReply{AskRefusal::dailyLimit});
    return;
  }

  workers_.getNextLoop()->queueInLoop(
      [this, caller, thread, turns = std::move(turns), done = std::move(done)]() mutable {
        // THE GRANT, SAID OUT LOUD AT THE CALL SITE. Ask acts as the signed-in account, and the three
        // levels are named one by one rather than taken as `everything()` — so a fourth level, or a
        // second product, never rides along on a token nobody widened.
        //
        // BUT IT IS NOT THE LOCK, AND IT WOULD BE DISHONEST TO READ IT AS ONE: gym's tool host does
        // not gate, so this scope narrows nothing gym publishes — all three levels are gym's own, and
        // there is no second product on this host for it to keep out. The whole ceiling is `AskTools`
        // below, which offers the reads and the two proposal mints and refuses everything else, and
        // which reads THIS scope on the way past so a narrower one would take tools away for real.
        // What the three levels buy today is that: honest wiring, and a lock that already obeys it.
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
          // NOTHING SITS ABOVE A WORKER LOOP. An exception that leaves this lambda is not a failed
          // question, it is the whole process — every product on this box — gone, with the lifter's
          // request never answered either. The vendor edge is the one place a document nobody here
          // wrote is walked (a reply shaped unlike the one the loop reads), and every diagnostic is
          // the same fact to the lifter anyway: nothing came back.
          LOG_ERROR << "gym ask run threw: " << failed.what();
          reply.answer = AskAnswer{false, "", failed.what(), {}};
        }
        // A RUN THAT REACHED NOBODY IS NOT ONE OF THE DAY'S QUESTIONS — AND THE TEST IS WHETHER IT
        // COST ANYTHING, NOT WHETHER IT ANSWERED. Three dead upstreams used to spend a lifter's whole
        // burst and then tell them, in the cap's own copy, that they had used the day having been
        // answered nothing; that is what `modelTurns == 0` gives back — a fuse trip, a wedged vendor,
        // a log we could not open, all of them before a token was billed.
        //
        // What is NOT given back is the failure that spent: hitting the iteration cap costs eight
        // metered turns and stopping at max_tokens costs one, and both reach the lifter as the same
        // "Ask didn't answer". Refunding those made the cap's OWN copy the false one — "about ten
        // questions a day" never bit on the most expensive runs the product has, because the runs
        // that burn the most turns are exactly the ones that end without an answer.
        //
        // A run that THREW is given back whatever it spent: the count died with the stack, and a
        // crash of ours is not a question of theirs.
        if (reply.answer.modelTurns == 0) perAccount_.giveBack(caller.str());
        reply.read = hands.read().tally();
        reply.proposals = hands.proposals();
        // THE CONVERSATION IS WRITTEN ONLY ONCE IT HAS AN ANSWER, and both halves land together: a
        // question nobody answered is not a turn, exactly as it is not one of the day's questions.
        // So a failed ask leaves the thread as it found it — a first ask that failed takes its own
        // empty row back with it, and the retry appends the question once rather than twice.
        //
        // A proposal the dead run managed to mint keeps its row and loses its thread link, which is
        // the rule the lifter's own delete obeys: the conversation goes, the consequence stays.
        if (!reply.answer.ok) {
          log_.discardEmptyThread(caller, thread);
          done(std::move(reply));
          return;
        }
        log_.appendTurns(caller, thread, {ThreadTurn{true, turns.back().text},
                                          ThreadTurn{false, reply.answer.answer}});
        done(std::move(reply));
      });
}

}
