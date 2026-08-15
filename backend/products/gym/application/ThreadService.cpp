#include "products/gym/application/ThreadService.h"

#include <unordered_map>

namespace wm::gym {

ThreadService::ThreadService(AskThreadRepository& threads, Clock& clock)
    : threads_(threads), clock_(clock) {}

// The three thread doors, and all three are pass-throughs on purpose: a conversation is stored
// exactly as it was had, so there is no rule to apply on the way out. The outcome is the one derived
// thing about a thread and it is derived where it is drawn, from the proposals that ride with it.
std::vector<AskThread> ThreadService::threads(const UserId& user) {
  return threads_.threads(user);
}

std::optional<AskThread> ThreadService::thread(const UserId& user, const ThreadId& id) {
  return threads_.thread(user, id);
}

bool ThreadService::deleteThread(const UserId& user, const ThreadId& id) {
  return threads_.deleteThread(user, id);
}

ThreadOpenOutcome ThreadService::openThread(const UserId& user, const ThreadId& id,
                                            const std::string& title) {
  return threads_.openThread(user, id, title, clock_.nowMs());
}

// ONE CLOCK READ FOR THE PAIR, because the pair is one exchange: the question and the answer to it
// are dated by the moment it settled, and two reads would let the answer appear to arrive before the
// question on a clock that stepped between them.
void ThreadService::appendTurns(const UserId& user, const ThreadId& id,
                                std::vector<ThreadTurn> turns) {
  const std::uint64_t nowMs = clock_.nowMs();
  for (ThreadTurn& turn : turns) turn.atMs = nowMs;
  threads_.appendTurns(user, id, turns);
}

void ThreadService::discardEmptyThread(const UserId& user, const ThreadId& id) {
  threads_.discardEmptyThread(user, id);
}

// Two loads and one rule between them: the store renders every turn as text (it does gym's calendar
// work, and a second date formatter is a second answer), the domain reads each thread's proposals
// for what came of it, and the outcome is stamped onto that thread's rows here. Nothing about a
// conversation is decided in SQL.
//
// `allThreads` AND NOT `threads`, WHICH IS THE FIX FOR A REAL HOLE: the list read stops at
// kThreadList, so an account's 201st conversation exported with a blank outcome while the app's own
// read of that same thread said `applied · 4 · Push A`. A ceiling is honest on a screen and a lie in
// an archive. Folding the outcomes into a map first is the same correction seen from the other side
// — the old nested walk was O(threads × turns) over a whole account, per export.
std::vector<ExportedThreadTurn> ThreadService::exportedThreadTurns(const UserId& user) {
  std::unordered_map<std::string, ThreadOutcome> outcomes;
  for (const AskThread& thread : threads_.allThreads(user))
    outcomes.emplace(thread.id.str(), outcomeOf(thread));

  std::vector<ExportedThreadTurn> turns = threads_.exportedThreadTurns(user);
  for (ExportedThreadTurn& turn : turns) {
    const auto found = outcomes.find(turn.threadId);
    if (found == outcomes.end()) continue;
    turn.outcome = toString(found->second.kind);
    // A count of nothing is an EMPTY CELL and never a zero: `read only` counts no changes because
    // none were proposed, and a 0 there would read as a real number somebody could sum.
    if (found->second.changes > 0) turn.changes = std::to_string(found->second.changes);
    turn.routine = found->second.routineName;
  }
  return turns;
}

}
