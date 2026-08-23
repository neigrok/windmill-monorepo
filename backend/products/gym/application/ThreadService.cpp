#include "products/gym/application/ThreadService.h"

#include <unordered_map>

namespace wm::gym {

ThreadService::ThreadService(AskThreadRepository& threads, Clock& clock)
    : threads_(threads), clock_(clock) {}

// Pass-throughs: a conversation is stored exactly as it was had, and the outcome is derived where it
// is drawn.
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

// One clock read for the pair: two reads could date the answer before the question.
void ThreadService::appendTurns(const UserId& user, const ThreadId& id,
                                std::vector<ThreadTurn> turns) {
  const std::uint64_t nowMs = clock_.nowMs();
  for (ThreadTurn& turn : turns) turn.atMs = nowMs;
  threads_.appendTurns(user, id, turns);
}

void ThreadService::discardEmptyThread(const UserId& user, const ThreadId& id) {
  threads_.discardEmptyThread(user, id);
}

// Two loads and one rule between them: the store renders every turn as text, the domain reads each
// thread's proposals for what came of it, and the outcome is stamped onto that thread's rows here.
// `allThreads` and not `threads`: the list read stops at kThreadList and an export may not.
std::vector<ExportedThreadTurn> ThreadService::exportedThreadTurns(const UserId& user) {
  std::unordered_map<std::string, ThreadOutcome> outcomes;
  for (const AskThread& thread : threads_.allThreads(user))
    outcomes.emplace(thread.id.str(), outcomeOf(thread));

  std::vector<ExportedThreadTurn> turns = threads_.exportedThreadTurns(user);
  for (ExportedThreadTurn& turn : turns) {
    const auto found = outcomes.find(turn.threadId);
    if (found == outcomes.end()) continue;
    turn.outcome = toString(found->second.kind);
    // A count of nothing is an empty cell, never a zero somebody could sum.
    if (found->second.changes > 0) turn.changes = std::to_string(found->second.changes);
    turn.routine = found->second.routineName;
  }
  return turns;
}

}
