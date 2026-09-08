#include "products/gym/application/ThreadService.h"

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

}
