#include "products/gym/application/ThreadService.h"
#include <algorithm>

namespace wm::gym {

ThreadService::ThreadService(AskThreadRepository& threads, Clock& clock)
    : threads_(threads), clock_(clock) {}

std::optional<CoachImage> ThreadService::image(const UserId& user, const ThreadId& thread, const std::string& id) {
  return threads_.image(user, thread, id);
}

ImageWriteError ThreadService::putImage(const UserId& user, const ThreadId& thread, const CoachImage& image) {
  return threads_.putImage(user, thread, image);
}

std::optional<AskGeneration> ThreadService::generation(const UserId& user, const ThreadId& thread, const std::string& requestId) {
  return threads_.generation(user, thread, requestId);
}

std::optional<AskGeneration> ThreadService::stopGeneration(const UserId& user, const ThreadId& thread, const std::string& requestId) {
  return threads_.stopGeneration(user, thread, requestId);
}

// Pass-throughs: a conversation is stored exactly as it was had, and the outcome is derived where it
// is drawn.
std::vector<AskThread> ThreadService::threads(const UserId& user) {
  return threads_.threads(user);
}

std::vector<AskThread> ThreadService::threads(const UserId& user, const ThreadCursor& cursor) {
  return threads_.threadPage(user, cursor);
}

std::optional<AskThread> ThreadService::thread(const UserId& user, const ThreadId& id,
                                             std::uint64_t before, int limit) {
  return threads_.messagePage(user, id, before, std::min(200, std::max(2, limit + limit % 2)));
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
