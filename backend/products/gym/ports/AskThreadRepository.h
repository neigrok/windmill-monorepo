#pragma once

#include "products/gym/domain/Thread.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// One line of the threads export: text end to end, one row per turn, the thread's facts repeated on
// each. `text` is the turn as sent, byte for byte. The store leaves `outcome`, `changes` and
// `routine` empty — ThreadService stamps them on after the load via `outcomeOf` (domain/Thread.h).
struct ExportedThreadTurn {
  std::string threadId;
  std::string title;
  std::string outcome;
  std::string changes;      // empty where the outcome counts nothing
  std::string routine;      // empty where no single routine can be named
  std::string createdAt;
  std::string turnNumber;
  std::string from;         // "lifter" | "ask"
  std::string text;
  std::string saidAt;

  bool operator==(const ExportedThreadTurn&) const = default;
};

// `idTaken` is an id already spent on a thread this account cannot see: the primary key is global,
// so a write must refuse rather than append.
enum class ThreadOpenError { none, idTaken };

// An absent thread with no named error is the two-accounts-one-id race; callers must read it as
// `idTaken` and never as a fresh conversation.
struct ThreadOpenOutcome {
  std::optional<AskThread> thread;   // the conversation so far; its turns are empty on a fresh one
  ThreadOpenError error;
};

// Ask's door to gym storage: the threads and their turns. A thread's proposals are the program's
// rows, read onto the thread through `thread_id`. Every read and write is owner-scoped by the UserId
// it carries; absent is byte-identical to forbidden, except where openThread says otherwise.
struct AskThreadRepository {
  virtual ~AskThreadRepository() = default;

  // `threads` carries every thread's proposals and none of its turns; `thread` is the conversation
  // whole.
  virtual std::vector<AskThread> threads(const UserId& user) = 0;   // newest asked first, bounded
  virtual std::optional<AskThread> thread(const UserId& user, const ThreadId& id) = 0;
  // Every thread, unbounded: the export may not be bounded the way the list read is.
  virtual std::vector<AskThread> allThreads(const UserId& user) = 0;   // oldest first, every row
  // Lands before the model runs: a proposal minted mid-conversation points at this row. The title is
  // written once on the insert; a later ask into the same thread passes it and it is ignored.
  virtual ThreadOpenOutcome openThread(const UserId& user, const ThreadId& id,
                                       const std::string& title, std::uint64_t nowMs) = 0;
  // Appended only once an answer has landed, and `asked_at` moves with them; a failed run calls
  // discardEmptyThread instead and leaves this table as it found it.
  virtual void appendTurns(const UserId& user, const ThreadId& id,
                           const std::vector<ThreadTurn>& turns) = 0;
  // Reverses an `openThread` whose run never answered: removes the row only while it holds no turns.
  // A proposal the dead run minted keeps its row and loses its thread link.
  virtual void discardEmptyThread(const UserId& user, const ThreadId& id) = 0;
  // The turns cascade; the proposals do not — the schema sets their `thread_id` null.
  virtual bool deleteThread(const UserId& user, const ThreadId& id) = 0;   // false = nothing to remove
  // Every turn this account holds, oldest thread first and in turn order; the outcome columns come
  // back empty and the service fills them. A thread holding no turns still gets a row, with the turn
  // columns empty.
  virtual std::vector<ExportedThreadTurn> exportedThreadTurns(const UserId& user) = 0;
};

}
