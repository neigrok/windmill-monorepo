#pragma once

#include "products/gym/domain/Thread.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// One line of the threads export, under the same rule ExportedSet obeys: TEXT end to end, because a
// CSV is text and Postgres renders every one of these better than C++ would. ONE ROW PER TURN, with
// the thread's own facts riding beside each — a CSV row is flat, and a reader who opens the file
// should not have to join the conversation back together to read it. `text` is the turn as sent,
// byte for byte: an export that summarised what a lifter typed would be the one thing this whole
// section refuses.
//
// THE STORE LEAVES `outcome`, `changes` AND `routine` EMPTY. They are `outcomeOf` (domain/Thread.h)
// read over the thread's proposals, and LogService stamps them on after the load — the same
// two-phase shape every computed surface in this product takes. A CASE expression in SQL would be a
// second copy of that ladder in a language the domain cannot read, and the second copy is the one
// that goes wrong.
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

// What became of opening a thread to ask into it. `idTaken` is the id spent on a thread this account
// cannot see, and it is the ONE place the two absences are told apart: every read below answers
// absent and another account's identically, but a WRITE cannot — the primary key is global, so an id
// somebody else holds has to be refused rather than quietly appended to. It is the same split
// `spentId` makes for a proposal, asked before a single vendor token is spent.
enum class ThreadOpenError { none, idTaken };

// AN ABSENT THREAD WITH NO NAMED ERROR IS THE RACE, AND CALLERS MUST READ IT AS `idTaken`. Two
// accounts minting one id at once: the loser's global probe finds the id free, its insert loses to
// `ON CONFLICT DO NOTHING`, and its owner-scoped read back comes home empty. The store cannot call
// that `idTaken` without a second probe it does not need, and no caller may treat it as a fresh
// conversation — a thread this account will never be able to write a turn into is not one to spend a
// vendor token on.
struct ThreadOpenOutcome {
  std::optional<AskThread> thread;   // the conversation so far; its turns are empty on a fresh one
  ThreadOpenError error;
};

// Ask's door to gym storage: the threads and their turns (§O). One of five aggregate ports over
// one Postgres database (LogRepository, CatalogRepository, ProgramRepository,
// PreferencesRepository are the others). A thread's proposals are the program's rows, not this
// port's — the store reads them onto the thread through `thread_id`, and a deleted thread leaves
// them standing with that link set null. Every read and write is owner-scoped by the UserId it
// carries; absent is byte-identical to forbidden, except where openThread says otherwise.
struct AskThreadRepository {
  virtual ~AskThreadRepository() = default;

  // carries every thread's proposals and none of its turns, because the outcome is derived from the
  // first and the second is a screen nobody is on yet. `thread` is the conversation whole.
  //
  // Neither read tells absent from another account's, exactly as every other read here refuses to.
  // `openThread` is the one that must, and it says why at ThreadOpenError.
  virtual std::vector<AskThread> threads(const UserId& user) = 0;   // newest asked first, bounded
  virtual std::optional<AskThread> thread(const UserId& user, const ThreadId& id) = 0;
  // EVERY thread, unbounded, and it exists because the export is the one door that may not be
  // bounded. The export used to stamp its outcomes from the LIST read, which stops at kThreadList —
  // so a lifter's 201st conversation exported with a blank outcome while the app's own read of that
  // same thread said `applied · 4 · Push A`, under a route whose comment promised nothing omitted.
  // A ceiling is honest on a screen and a lie in an archive, so the archive gets its own read.
  virtual std::vector<AskThread> allThreads(const UserId& user) = 0;   // oldest first, every row
  // The ask's first write, and it lands BEFORE the model runs for a reason that is not politeness:
  // a proposal minted mid-conversation points at this row, so the row has to exist by then. The
  // title is written once, on the insert, from the lifter's first message — a later ask into the
  // same thread passes it and it is ignored, because a thread is named by how it opened.
  virtual ThreadOpenOutcome openThread(const UserId& user, const ThreadId& id,
                                       const std::string& title, std::uint64_t nowMs) = 0;
  // The pair, appended only once an answer has landed, and `asked_at` moves with them. A question
  // nobody answered is not a turn — the same rule the day's ration keeps — so a run that failed
  // calls the next one instead and this table is left exactly as it was found.
  virtual void appendTurns(const UserId& user, const ThreadId& id,
                           const std::vector<ThreadTurn>& turns) = 0;
  // The reversal of an `openThread` whose run never answered: it removes the row ONLY while it holds
  // no turns, so a failed follow-up cannot take a conversation that already happened with it. A
  // proposal the dead run managed to mint keeps its own row and loses its thread link, which is the
  // same rule the lifter's own delete obeys.
  virtual void discardEmptyThread(const UserId& user, const ThreadId& id) = 0;
  // The lifter's delete, and the whole of §O's second half: the conversation goes and the
  // consequence stays. The turns cascade; the PROPOSALS DO NOT — `thread_id` is set null by the
  // schema, so an applied change is still in the routine's history saying it came from Ask, and it
  // simply no longer opens something that exists.
  virtual bool deleteThread(const UserId& user, const ThreadId& id) = 0;   // false = nothing to remove
  // Every turn this account holds, oldest thread first and in turn order, for the export that omits
  // nothing. The outcome columns come back empty and the service fills them, for the reason
  // ExportedThreadTurn states.
  //
  // A THREAD THAT HOLDS NO TURNS STILL GETS A ROW, with the turn columns empty. Such a thread is
  // real and not rare: `openThread` commits before the model runs, so one exists for the whole of
  // every in-flight ask, and permanently if the process died between the insert and the answer. It
  // is in the list read and it is the lifter's to delete, so an export that dropped it would be
  // omitting something the same account can see on screen.
  virtual std::vector<ExportedThreadTurn> exportedThreadTurns(const UserId& user) = 0;
};

}
