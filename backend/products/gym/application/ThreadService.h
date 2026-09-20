#pragma once

#include "platform/ports/Clock.h"
#include "products/gym/ports/AskThreadRepository.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// Separate from AskService so a deployment with no vendor key wired, which registers no
// `POST /v1/gym/ask`, still reads and deletes the threads it already has.
// The OUTCOME is derived where it is drawn (`outcomeOf`) and never stored.
class ThreadService {
public:
  ThreadService(AskThreadRepository& threads, Clock& clock);

  std::optional<CoachImage> image(const UserId& user, const ThreadId& thread, const std::string& id);
  ImageWriteError putImage(const UserId& user, const ThreadId& thread, const CoachImage& image);
  std::optional<AskGeneration> generation(const UserId& user, const ThreadId& thread, const std::string& requestId);
  std::optional<AskGeneration> stopGeneration(const UserId& user, const ThreadId& thread, const std::string& requestId);
  std::vector<AskThread> threads(const UserId& user);
  std::vector<AskThread> threads(const UserId& user, const ThreadCursor& cursor);
  std::optional<AskThread> thread(const UserId& user, const ThreadId& id, std::uint64_t before, int limit);
  std::optional<AskThread> thread(const UserId& user, const ThreadId& id);
  // The conversation goes, the consequence stays: an applied change is still in the routine's
  // history.
  bool deleteThread(const UserId& user, const ThreadId& id);

  ThreadOpenOutcome openThread(const UserId& user, const ThreadId& id, const std::string& title);
  void appendTurns(const UserId& user, const ThreadId& id, std::vector<ThreadTurn> turns);
  void discardEmptyThread(const UserId& user, const ThreadId& id);

private:
  AskThreadRepository& threads_;
  Clock& clock_;
};

}
