#pragma once

#include "products/gym/domain/Proposal.h"
#include "products/gym/domain/Routine.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// Every routine-write refusal crosses as a value. idTaken is insertRoutine's (the id is spent on a
// row this account does not own, never whose); notFound is replaceRoutine's (absent and another
// account's alike); unknownExercise is either's. `stale` is replaceRoutine's alone and only when the
// caller NAMED the revision it read. A PUT naming no revision always lands.
enum class RoutineWriteError { none, idTaken, notFound, unknownExercise, stale };

struct RoutineWriteOutcome {
  std::optional<Routine> routine;
  RoutineWriteError error;
};

// What a surface is asking the proposal ledger for.
struct ProposalQuery {
  std::optional<RoutineId> routine;
  bool pendingOnly = false;

  bool operator==(const ProposalQuery&) const = default;
};

// `proposal` is present exactly when kind is `proposal`, and carries the actor in `source.door`.
// `door` and `movements` belong to the created row alone — an absent door is the lifter's own hand,
// and an absent `movements` means the count was never recorded.
enum class RoutineEventKind { created, proposal };

struct RoutineEvent {
  RoutineEventKind kind;
  std::uint64_t atMs;
  std::optional<ProposalDoor> door;       // created only; absent = the lifter's own hand
  std::optional<int> movements;           // created only; absent = never recorded
  std::optional<ProposalHead> proposal;   // present exactly when kind == proposal

  bool operator==(const RoutineEvent&) const = default;
};

// The creation row is always last and never counts against this, so it bounds the proposals above it.
constexpr int kRoutineHistoryProposals = 20;

// A spent id splits three ways: `idTaken` is an id spent on a proposal this account cannot see; the
// caller's own id carrying the SAME document is the replay and reads back the stored proposal
// untouched; the caller's own id carrying a DIFFERENT document is `idReused`.
// `unknownRoutine` is absent and another account's alike. `unknownExercise` is refused here rather
// than at apply. `noChange` — a document identical to what the routine already says — is decided
// before a row is built and the store never sees it.
enum class ProposalMintError { none, idTaken, idReused, unknownRoutine, unknownExercise, noChange };

struct ProposalMintOutcome {
  std::optional<RoutineProposal> proposal;
  ProposalMintError error;
};

// Three reasons a proposal is past settling, each its own sentence at the door, one code for all:
// `routineMoved` — the base moved since the mint (a pending row is settled as superseded as it
// answers; a row already superseded whose revision no longer matches says the same); `replaced` —
// a newer proposal from the same door and connection took the pending slot, and
// `gym_proposals.superseded_by` names it, which is decided BEFORE the revision because a routine
// can move after the second mint too; `superseded` — a row settled as superseded before the reason
// column existed, with the revision unmoved, so the store cannot say which. `settled`: a proposal
// already applied or dismissed is being asked for the OTHER one; asking for the state it already
// holds is a replay and answers with the stored row.
enum class ProposalSettleError { none, notFound, routineMoved, replaced, superseded, settled };

struct ProposalSettleOutcome {
  std::optional<RoutineProposal> proposal;
  std::optional<Routine> routine;   // how the routine now stands; absent on a dismiss and a removal
  ProposalSettleError error;
};

// The routines and the proposal ledger against them; they are written in one transaction.
// Every read and write is owner-scoped by the UserId it carries; absent is byte-identical to
// forbidden. insertRoutine and insertProposal are idempotent by client-minted id and answer with the
// row that is stored; replaceRoutine is idempotent by shape, the whole document.
struct ProgramRepository {
  virtual ~ProgramRepository() = default;

  // Both reads carry lastTrainedAtMs, an aggregate over the log rather than a column; its absence is
  // the whole of `untested`.
  virtual std::vector<Routine> routines(const UserId& user) = 0;   // most recently trained first
  virtual std::optional<Routine> routine(const UserId& user, const RoutineId& id) = 0;
  // The routine's dated history, newest first, with its creation row last.
  virtual std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id) = 0;
  // The routine row and its entries land in one transaction. `byAgent` is a fact about the write,
  // not the document — a later replace must not rewrite it. `nowMs` dates the creation row from the
  // service's clock, never the database's.
  virtual RoutineWriteOutcome insertRoutine(const Routine& incoming,
                                            std::optional<ProposalDoor> byAgent,
                                            std::uint64_t nowMs) = 0;   // conflict = the stored
  // Reached by `PUT /v1/gym/routines/{id}` and by no MCP tool at any grant level. Moves the revision
  // and, in the same transaction, supersedes every proposal still pending on that routine. `nowMs`
  // dates those supersessions, from the service's clock.
  virtual RoutineWriteOutcome replaceRoutine(const Routine& incoming, std::uint64_t nowMs,
                                             std::optional<int> expectedRevision) = 0;
  virtual bool deleteRoutine(const UserId& user, const RoutineId& id) = 0;  // false = nothing to remove

  // An agent reaches exactly one of these, the mint; the other three are the lifter's.
  // `proposalHeads` carries no diff rows; `proposal` is the one that fills `loggedSets` on a removed
  // line, counted at read rather than at mint.
  virtual std::vector<ProposalHead> proposalHeads(const UserId& user, const ProposalQuery& query) = 0;
  virtual std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id) = 0;
  // One transaction: the proposal row, its lines, and the supersession of whatever was pending from
  // the same door — that row's `superseded_by` records this proposal's id, so a later settle can say
  // a newer proposal replaced it. The routine is resolved under the caller's own scope inside that
  // transaction.
  virtual ProposalMintOutcome insertProposal(const RoutineProposal& incoming) = 0;
  // All-or-none. `becomes` is what the domain computed from the base; the store re-checks the
  // revision under its own lock and refuses the whole thing if the routine moved between the two.
  virtual ProposalSettleOutcome applyRevision(const UserId& user, const ProposalId& id,
                                              const Routine& becomes, std::uint64_t nowMs) = 0;
  // Deletes the routine, so its entries, its sessions' pointers and this proposal's own row go with
  // it (`on delete cascade`); the answer is composed before the delete.
  virtual ProposalSettleOutcome applyRemoval(const UserId& user, const ProposalId& id,
                                             std::uint64_t nowMs) = 0;
  // Nothing changes; the proposal stays in the routine's history.
  virtual ProposalSettleOutcome dismissProposal(const UserId& user, const ProposalId& id,
                                                std::uint64_t nowMs) = 0;
};

}
