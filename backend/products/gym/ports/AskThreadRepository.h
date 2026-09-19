#pragma once

#include "products/gym/domain/Thread.h"
#include "platform/ports/ToolHost.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// `idTaken` is an id already spent on a thread this account cannot see: the primary key is global,
// so a write must refuse rather than append.
enum class ThreadOpenError { none, idTaken };

// An absent thread with no named error is the two-accounts-one-id race; callers must read it as
// `idTaken` and never as a fresh conversation.
struct ThreadOpenOutcome {
  std::optional<AskThread> thread;   // the conversation so far; its turns are empty on a fresh one
  ThreadOpenError error;
};

struct CoachImage {
  CoachAttachment attachment;
  std::string data;
};

enum class ImageWriteError { none, notFound, idTaken, dailyLimit };

struct ThreadLease {
  virtual ~ThreadLease() = default;
};

struct CoachOperation {
  std::string id;
  std::string name;
  Json::Value arguments;
  std::optional<ToolResult> result;
};

// Ask's door to gym storage: the threads and their turns. A thread's proposals are the program's
// rows, read onto the thread through `thread_id`. Every read and write is owner-scoped by the UserId
// it carries; absent is byte-identical to forbidden, except where openThread says otherwise.
struct AskThreadRepository {
  virtual ~AskThreadRepository() = default;
  virtual std::optional<CoachImage> image(const UserId& user, const ThreadId& thread, const std::string& id) = 0;
  virtual ImageWriteError putImage(const UserId& user, const ThreadId& thread, const CoachImage& image) = 0;
  virtual std::optional<AskGeneration> stopGeneration(const UserId& user, const ThreadId& thread,
                                                     const std::string& requestId) = 0;
  virtual bool threadAvailable(const UserId& user, const ThreadId& id) = 0;
  virtual std::unique_ptr<ThreadLease> tryLease(const UserId& user, const ThreadId& id) = 0;
  virtual std::vector<AskThread> threadPage(const UserId& user, const ThreadCursor& cursor) = 0;
  virtual std::optional<AskThread> messagePage(const UserId& user, const ThreadId& id,
                                              std::uint64_t before, int limit) = 0;
  virtual std::optional<AskGeneration> generation(const UserId& user, const ThreadId& thread,
                                                 const std::string& requestId) = 0;
  virtual void saveGeneration(const UserId& user, const ThreadId& thread,
                              AskGeneration& generation) = 0;
  virtual std::optional<CoachOperation> operation(const UserId& user, const ThreadId& thread,
                                                const std::string& generationId) = 0;
  virtual void saveOperation(const UserId& user, const ThreadId& thread,
                             const std::string& generationId, const CoachOperation& operation) = 0;

  // `threads` carries every thread's proposals and none of its turns; `thread` is the conversation
  // whole.
  virtual std::vector<AskThread> threads(const UserId& user) = 0;   // newest asked first, bounded
  virtual std::optional<AskThread> thread(const UserId& user, const ThreadId& id) = 0;
  // Lands before the model runs: a proposal minted mid-conversation points at this row. The title is
  // written once on the insert; a later ask into the same thread passes it and it is ignored.
  virtual ThreadOpenOutcome openThread(const UserId& user, const ThreadId& id,
                                       const std::string& title, std::uint64_t nowMs) = 0;
  // Legacy append path; durable Coach requests use saveGeneration for atomic terminal persistence.
  virtual void appendTurns(const UserId& user, const ThreadId& id,
                           const std::vector<ThreadTurn>& turns) = 0;
  // Removes only a thread with neither messages nor a generation.
  virtual void discardEmptyThread(const UserId& user, const ThreadId& id) = 0;
  // The turns cascade; the proposals do not — the schema sets their `thread_id` null.
  virtual bool deleteThread(const UserId& user, const ThreadId& id) = 0;   // false = nothing to remove
};

}
