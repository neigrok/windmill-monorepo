#pragma once

#include "platform/ports/Clock.h"
#include "products/gym/ports/AskThreadRepository.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// ASK'S THREADS (§O) — one of five services, each over the aggregate port of the same name
// (TrainingService, CatalogService, ProgramService, PreferencesService are the other four) — and
// they live HERE rather than on AskService for a reason a lifter would recognise: a conversation
// they had is their data, not a feature of the model. A deployment with no vendor key wired
// registers no `POST /v1/gym/ask` at all, and the threads already had are still theirs to read, to
// export and to delete. Ask writes them; this keeps them.
//
// Each read hands back the domain value whole and the OUTCOME is derived at the edge that draws
// it (`outcomeOf`, domain/Thread.h), never stored: the proposals are the outcome, and a column
// beside them would be a second copy of a fact the ledger already holds.
class ThreadService {
public:
  ThreadService(AskThreadRepository& threads, Clock& clock);

  std::vector<AskThread> threads(const UserId& user);
  std::optional<AskThread> thread(const UserId& user, const ThreadId& id);
  // The lifter's delete, and the whole of it: the conversation goes, the consequence stays. An
  // applied change is still in the routine's history saying it came from Ask — it just no longer
  // opens a conversation that exists.
  bool deleteThread(const UserId& user, const ThreadId& id);
  // Threads in the export with everything else (§O), and the second half of the trust argument for a
  // multi-year artifact: a lifter walks away with what they asked and what was answered, byte for
  // byte. It is the two-phase shape — the store renders the rows, the domain decides each thread's
  // outcome, and this stamps the second onto the first. UNBOUNDED on both halves — the outcomes come
  // from `allThreads` rather than the list read, because a ceiling that is honest on a screen is a
  // lie in an archive, and every thread that exists is in the file whether or not it holds a turn.
  std::vector<ExportedThreadTurn> exportedThreadTurns(const UserId& user);

  // The three WRITES, and Ask is their only caller — they live here rather than on AskService
  // because this is the object that holds the store and the clock, and a conversation is dated by
  // the server's clock like every instant the server itself decides. `openThread` lands before the
  // model runs (a proposal minted mid-conversation points at the row); `appendTurns` lands only once
  // an answer has, so a question nobody answered is not a turn; `discardEmptyThread` is what takes
  // back a thread whose run never answered, and it can only ever take one that holds no turns.
  ThreadOpenOutcome openThread(const UserId& user, const ThreadId& id, const std::string& title);
  void appendTurns(const UserId& user, const ThreadId& id, std::vector<ThreadTurn> turns);
  void discardEmptyThread(const UserId& user, const ThreadId& id);

private:
  AskThreadRepository& threads_;
  Clock& clock_;
};

}
