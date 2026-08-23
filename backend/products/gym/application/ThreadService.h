#pragma once

#include "platform/ports/Clock.h"
#include "products/gym/ports/AskThreadRepository.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// Ask's threads. They live here rather than on AskService so a deployment with no vendor key wired,
// which registers no `POST /v1/gym/ask`, still reads, exports and deletes the threads already had.
//
// Each read hands back the domain value whole; the OUTCOME is derived where it is drawn
// (`outcomeOf`, domain/Thread.h) and never stored.
class ThreadService {
public:
  ThreadService(AskThreadRepository& threads, Clock& clock);

  std::vector<AskThread> threads(const UserId& user);
  std::optional<AskThread> thread(const UserId& user, const ThreadId& id);
  // The conversation goes, the consequence stays: an applied change is still in the routine's
  // history saying it came from Ask.
  bool deleteThread(const UserId& user, const ThreadId& id);
  // Two-phase: the store renders the rows, the domain decides each thread's outcome, and this stamps
  // the second onto the first. UNBOUNDED on both halves — the outcomes come from `allThreads`, not
  // the list read — and every thread is in the file whether or not it holds a turn.
  std::vector<ExportedThreadTurn> exportedThreadTurns(const UserId& user);

  // The three writes, Ask being their only caller; a conversation is dated by the server's clock.
  // `openThread` lands before the model runs, a proposal minted mid-conversation pointing at the row;
  // `appendTurns` lands only once an answer has; `discardEmptyThread` takes back a thread whose run
  // never answered, and only ever one holding no turns.
  ThreadOpenOutcome openThread(const UserId& user, const ThreadId& id, const std::string& title);
  void appendTurns(const UserId& user, const ThreadId& id, std::vector<ThreadTurn> turns);
  void discardEmptyThread(const UserId& user, const ThreadId& id);

private:
  AskThreadRepository& threads_;
  Clock& clock_;
};

}
