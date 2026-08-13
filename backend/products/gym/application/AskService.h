#pragma once

#include "platform/application/Entitlements.h"
#include "platform/domain/Ids.h"
#include "platform/ports/ToolHost.h"
#include "products/gym/adapters/mcp/GymTools.h"
#include "products/gym/application/LogService.h"
#include "products/gym/domain/ReadReceipt.h"
#include "products/gym/ports/AskAgent.h"

#include <trantor/net/EventLoopThreadPool.h>

#include <chrono>
#include <cstddef>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace wm::gym {

// ASK'S HANDS, AND THE NARROWING THAT MAKES THEM SAFE TO HAND A MODEL. Gym's tool host does not
// gate — by design, because over MCP the grant was already settled above it by CompositeToolHost — so
// a chat wired straight to it would be a door with no lock, and a hallucinated `discard_session`
// would execute. This is that lock, and it is gym's twin of roadmap's ScopedToolHost:
//
//   READS, and the tools that MINT A PROPOSAL. Nothing else — and the rule is read off the
//   declarations rather than off a list of names that could drift from them: every `Access::read`
//   tool, plus `mintsProposal` (GymToolCatalog.h), which is the safeguard ladder's middle rung. What
//   that leaves out is every tool that CHANGES something: a set, a workout, a share, a movement. Ask
//   cannot reach them, so its refusal is a grant and not a sentence in a prompt — and W6 already saw
//   to it that no tool at any level edits or deletes a logged set, so this narrowing does not stand
//   alone either.
//
// THIS IS THE ONLY LOCK ON THE ASK DOOR, and saying otherwise would be the comfortable lie. The
// ToolScope AskService names at its call site is gym's own three levels against a host that does not
// gate, so it stops nothing gym publishes; it says who Ask acts as, and it is read HERE — both in
// the catalog `listTools` filters and in `callTool` — so that narrowing it later takes tools away in
// fact and not only on paper. One lock that obeys the grant beats two that were only ever counted.
//
// It also OBSERVES, which is the second half of its job and the reason it is a class rather than a
// filter: what the run actually read (`read()`) and what it actually minted (`proposals()`) are facts
// the server holds, and both are printed to the lifter. Neither is ever taken from the model's prose.
class AskTools : public ToolHost {
public:
  // The thread is carried, not looked up: every proposal this run mints is stamped with the
  // conversation it came out of, so the routine's history leads back to the evening that caused it
  // and the thread's row can say what came of it. W7 had nothing to stamp — it kept no conversation
  // — which is exactly what §O reversed.
  AskTools(GymTools& inner, ThreadId thread);

  std::vector<ToolDeclaration> declareTools() const override;
  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller) override;

  const ReadReceipt& read() const { return read_; }
  const std::vector<std::string>& proposals() const { return proposals_; }

private:
  GymTools& inner_;
  ThreadId thread_;
  ReadReceipt read_;
  std::vector<std::string> proposals_;
};

// Why an ask did not reach the model, as facts the HTTP edge maps to statuses. Every one of these is
// settled BEFORE a single token is spent, which is the whole point of the ordering: a malformed
// thread, a lifter mid-workout, and a lifter who has used the day never have a question sent
// anywhere.
enum class AskRefusal {
  none,
  threadMalformed,  // the id is not one this product can hold (domain/Training.h's id shape)
  threadTaken,      // the id names a conversation this account cannot see — refused, never appended
  questionEmpty,
  questionTooLong,
  questionUnstorable,  // a NUL or bytes that are not UTF-8 (storableText, domain/Training.h)
  tooManyTurns,
  notConfigured,    // no vendor key — in production the route is absent, so this is the fail-closed floor
  sessionOpen,      // a workout is running: Ask is never offered mid-session, and the server says so
  dailyLimit,       // the day's questions are used — the cap that keeps Ask open to everybody
  outOfBudget,      // this account is over OUR AI ceiling for the window — a fuse, not a sales door
};

// What the exchange produced, and three of the four are the SERVER's own observations rather than
// anything the model said: what it read, and which proposals it minted.
struct AskReply {
  AskRefusal refusal = AskRefusal::none;
  AskAnswer answer;                     // meaningful only when refusal == none
  ReadTally read;                       // what the run's tools actually served
  std::vector<std::string> proposals;   // ids minted during the exchange, in mint order
};

// What one turn may weigh. The count is `kMaxThreadTurns` (domain/Thread.h) and it is the thread's
// rule now rather than the request body's: the server assembles the prompt from what it stored, so
// the cap bounds the side that pays for it. A conversation about training that needs more than eight
// turns or a thousand bytes a turn is a different product.
constexpr std::size_t kMaxAskTurnBytes = 1000;

// THE DAILY LIMIT, AND IT IS A DESIGN ARTIFACT RATHER THAN AN OPS DETAIL. Ask is the first Windmill
// feature with a marginal cost per use, and therefore the first with a structural incentive to
// ration — so the ration is stated on screen in plain words instead of being hidden as a quietly
// weaker model. One bucket says both halves of it: about ten questions a day, three back to back.
//
// It is deliberately NOT a paywall. Windmill One cannot be bought (`paidPlansOpen()` is a hardcoded
// false and BillingApi 503s), so a locked Ask offering an upgrade would advertise a purchase that
// answers 503 — the dark pattern this brand's mission forecloses. Ask ships open to everyone with a
// cap; the One gate arms in the wave that opens checkout, and it is one line: `hasWindmillOne` beside
// the allowance read in `ask`, refusing where the allowance is read today.
//
// It is a BUCKET IN MEMORY and therefore best-effort — a deploy refills it. What does NOT refill it
// is the table's own housekeeping: `AskRation` forgets an account only once its bucket has caught all
// the way up, where forgetting it changes no answer at all. That is the honest limit of this rung and
// it is the right one to be soft: what must be HARD is the money, and the money is held by two ledger-
// backed ceilings this service reads below (the account's trailing-30-day allowance) and one the
// vendor edge reads for the whole process (`AiFuse`, hourly). This rung is the sentence a lifter
// reads; those two are the ones that cannot be walked around.
constexpr double kAskPerDay = 10.0;
constexpr double kAskBackToBack = 3.0;

// THE DAY'S QUESTIONS, HELD PER ACCOUNT — AND A QUESTION NOBODY ANSWERED IS NOT ONE OF THEM.
//
// A token bucket carrying the sentence above: `kAskBackToBack` in hand, refilling at `kAskPerDay` a
// day, keyed by the account because the spend is the account's. Per account and not per IP: a
// household behind one address should not share a ration.
//
// It is gym's own rather than platform's `RateLimiter`, and the one operation that limiter cannot
// offer is the whole reason: a run that reached nobody has to be GIVEN BACK. Three dead upstreams
// used to spend a lifter's whole burst and then tell them — in the cap's own copy, the one sentence
// this product rules must be plainly honest — that they had used the day's questions, having been
// answered none of them. The test for that is `AskAnswer::modelTurns`, which is what a run COST, and
// not `ok`, which is only whether it landed: a cap hit after eight billed turns is charged.
// The platform limiter is an IP brake at the HTTP edge with no way to return a token, and its idle
// sweep would hand a whole fresh burst to anyone who waited five minutes; the REQUEST beside this
// wave is a `giveBack` there, after which this collapses into it.
class AskRation {
public:
  // One of today's questions, or false when the account has spent them.
  bool take(const std::string& account);
  // A question that COST NOTHING, un-spent — never merely one that failed. A run that burned vendor
  // turns and then failed is charged like any other, or the ration would be waived on exactly the
  // runs that spend the most. Clamped at full, so a stray return cannot mint a fourth question out
  // of a burst of three.
  void giveBack(const std::string& account);

private:
  struct Held {
    double questions = kAskBackToBack;  // an account nobody has seen holds the whole burst
    std::chrono::steady_clock::time_point refilledAt{};
  };

  std::mutex mutex_;
  std::unordered_map<std::string, Held> held_;
};

// Ask, from the request's point of view: refuse everything refusable, then run the loop on a thread
// of this service's own and answer when it settles.
//
// THE WORKER POOL IS NOT AN OPTIMISATION. `AskAgent::answer` blocks for as long as the vendor takes,
// and this process serves every product from a handful of request loops — running the loop on the
// handler's thread would park one of them for a minute and stop the training log answering anybody.
// So the handler hands its callback over and returns; `done` fires on a worker.
class AskService {
public:
  AskService(LogService& log, AskAgent& agent, GymTools& gymTools, Entitlements& entitlements);

  // Whether this deployment can answer at all. main.cpp reads it to decide whether the route exists:
  // a button that answers 503 is worse than a door that was never drawn.
  bool configured() const;

  // ONE QUESTION INTO ONE THREAD, and the client no longer sends the conversation. W7 did, because
  // W7 kept none of it; now the server holds the thread, so the client sending a history of its own
  // would be a second, editable copy of what was said — the stored conversation and the prompt could
  // then disagree, and a lifter reading the thread back would be reading something the model never
  // saw. The id is the client's to mint (every gym write is), and a fresh one opens a thread titled
  // by this question, verbatim.
  void ask(const UserId& caller, const std::string& email, const ThreadId& thread,
           std::string question, std::function<void(AskReply)> done);

private:
  LogService& log_;
  AskAgent& agent_;
  GymTools& gymTools_;
  Entitlements& entitlements_;
  // One bucket carries the day's cap and the anti-hammer brake together, because they are one
  // sentence to a lifter — "that's Ask for now" — and two limiters would need two.
  AskRation perAccount_;
  trantor::EventLoopThreadPool workers_{2};
};

}
