#pragma once

#include "platform/application/Entitlements.h"
#include "platform/domain/Ids.h"
#include "platform/ports/ToolHost.h"
#include "products/gym/adapters/mcp/GymTools.h"
#include "products/gym/application/ThreadService.h"
#include "products/gym/application/TrainingService.h"
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

// The lock on the Ask door, and the only one: gym's tool host does not gate, because over MCP
// CompositeToolHost settled the grant above it. Ask reaches every `Access::read` tool plus those
// declaring `mintsProposal` (GymToolCatalog.h) and nothing else — the rule is read off the
// declarations, never off a list of names — so every tool that CHANGES a set, a workout, a share or a
// movement is out of reach. It is enforced in both `declareTools` and `callTool`.
//
// It also OBSERVES: what the run read (`read()`) and what it minted (`proposals()`) are the server's
// own facts, never taken from the model's prose.
class AskTools : public ToolHost {
public:
  // The thread is carried, not looked up: every proposal this run mints is stamped with the
  // conversation it came out of.
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

// Why an ask did not reach the model, as facts the HTTP edge maps to statuses. Every one is settled
// BEFORE a single token is spent.
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

// What the exchange produced; `read` and `proposals` are the server's own observations, never the
// model's.
struct AskReply {
  AskRefusal refusal = AskRefusal::none;
  AskAnswer answer;                     // meaningful only when refusal == none
  ReadTally read;                       // what the run's tools actually served
  std::vector<std::string> proposals;   // ids minted during the exchange, in mint order
};

// What one turn may weigh; the count is `kMaxThreadTurns` (domain/Thread.h).
constexpr std::size_t kMaxAskTurnBytes = 1000;

// The daily limit, stated on screen in plain words: about ten questions a day, three back to back.
// It is not a paywall — Windmill One cannot be bought, so a locked Ask would advertise a purchase
// that answers 503.
//
// It is a bucket in MEMORY and therefore best-effort: a deploy refills it, and `AskRation` forgets an
// account only once its bucket has caught all the way up. What is hard is the money, held by the
// account's trailing-30-day allowance read in `ask` and by `AiFuse` at the vendor edge.
constexpr double kAskPerDay = 10.0;
constexpr double kAskBackToBack = 3.0;

// A token bucket: `kAskBackToBack` in hand, refilling at `kAskPerDay` a day, keyed by the ACCOUNT
// and never by IP. It is gym's own rather than platform's `RateLimiter` because a run that reached
// nobody has to be GIVEN BACK, which that limiter cannot do. The test is `AskAnswer::modelTurns`,
// what a run COST, and never `ok`.
class AskRation {
public:
  // One of today's questions, or false when the account has spent them.
  bool take(const std::string& account);
  // A question that COST NOTHING, un-spent — never merely one that failed. Clamped at full, so a
  // stray return cannot mint a question beyond the burst.
  void giveBack(const std::string& account);

private:
  struct Held {
    double questions = kAskBackToBack;  // an account nobody has seen holds the whole burst
    std::chrono::steady_clock::time_point refilledAt{};
  };

  std::mutex mutex_;
  std::unordered_map<std::string, Held> held_;
};

// Refuse everything refusable, then run the loop on a worker of this service's own and answer when
// it settles. The pool is not an optimisation: `AskAgent::answer` blocks for as long as the vendor
// takes, and the process serves every product from a handful of request loops. `done` fires on a
// worker.
class AskService {
public:
  // The log answers "is a workout running" (never mid-session) and the threads keep what was asked
  // and answered.
  AskService(TrainingService& training, ThreadService& threads, AskAgent& agent,
             GymTools& gymTools, Entitlements& entitlements);

  // Whether this deployment can answer at all; main.cpp reads it to decide whether the route exists.
  bool configured() const;

  // One question into one thread; the server holds the conversation and the client never sends one.
  // The id is the client's to mint, and a fresh one opens a thread titled by this question, verbatim.
  void ask(const UserId& caller, const std::string& email, const ThreadId& thread,
           std::string question, std::function<void(AskReply)> done);

private:
  TrainingService& training_;
  ThreadService& threads_;
  AskAgent& agent_;
  GymTools& gymTools_;
  Entitlements& entitlements_;
  // One bucket carries the day's cap and the anti-hammer brake together.
  AskRation perAccount_;
  trantor::EventLoopThreadPool workers_{2};
};

}
