#pragma once

#include "platform/ports/Clock.h"
#include "products/gym/ports/AskThreadRepository.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// Separate from AskService so a deployment with no vendor key wired, which registers no
// `POST /v1/gym/ask`, still reads, exports and deletes the threads it already has.
// The OUTCOME is derived where it is drawn (`outcomeOf`) and never stored.
class ThreadService {
public:
  ThreadService(AskThreadRepository& threads, Clock& clock);

  std::vector<AskThread> threads(const UserId& user);
  std::optional<AskThread> thread(const UserId& user, const ThreadId& id);
  // The conversation goes, the consequence stays: an applied change is still in the routine's
  // history.
  bool deleteThread(const UserId& user, const ThreadId& id);
  // UNBOUNDED on both halves — the outcomes come from `allThreads`, not the list read — and every
  // thread is in the file whether or not it holds a turn.
  std::vector<ExportedThreadTurn> exportedThreadTurns(const UserId& user);

  // Ask is the only caller; a conversation is dated by the server's clock. `openThread` lands before
  // the model runs, a proposal minted mid-conversation pointing at the row; `appendTurns` lands only
  // once an answer has; `discardEmptyThread` takes back a thread holding no turns.
  ThreadOpenOutcome openThread(const UserId& user, const ThreadId& id, const std::string& title);
  void appendTurns(const UserId& user, const ThreadId& id, std::vector<ThreadTurn> turns);
  void discardEmptyThread(const UserId& user, const ThreadId& id);

private:
  AskThreadRepository& threads_;
  Clock& clock_;
};

}
