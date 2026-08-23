#pragma once

#include "products/gym/domain/Proposal.h"
#include "products/gym/domain/Routine.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// Every refusal a routine write can make, crossing as a value rather than a vendor exception.
// idTaken is insertRoutine's (the id is spent on a row this account does not own, never whose);
// notFound is replaceRoutine's (absent and another account's alike); unknownExercise is either's —
// an entry names a movement this account's catalog does not hold. `stale` is replaceRoutine's alone
// and only when the caller NAMED the revision it read: the day moved under it and the caller must
// re-read and save again. A PUT naming no revision always lands.
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

// One dated row of a routine's own history: the day being created, and every proposal minted
// against it, in one shape so no surface has to merge two lists by date. `proposal` is present
// exactly when kind is `proposal`, and carries the actor in `source.door`. `door` and `movements`
// belong to the created row alone — an absent door is the lifter's own hand, and an absent
// `movements` means the count was never recorded.
enum class RoutineEventKind { created, proposal };

struct RoutineEvent {
  RoutineEventKind kind;
  std::uint64_t atMs;
  std::optional<ProposalDoor> door;       // created only; absent = the lifter's own hand
  std::optional<int> movements;           // created only; absent = never recorded
  std::optional<ProposalHead> proposal;   // present exactly when kind == proposal

  bool operator==(const RoutineEvent&) const = default;
};

// How far back a routine's history reads. The creation row is always last and never counts against
// this, so it bounds the proposals above it.
constexpr int kRoutineHistoryProposals = 20;

// What became of a mint; every refusal crosses as a value.
//
// A spent id splits three ways: `idTaken` is an id spent on a proposal this account cannot see; the
// caller's own id carrying the SAME document is the replay and reads back the stored proposal
// untouched; the caller's own id carrying a DIFFERENT document is `idReused`.
//
// `unknownRoutine` is absent and another account's alike. `unknownExercise` is refused here rather
// than at apply, so a proposal a lifter cannot apply never reaches their screen. `noChange` — a
// document identical to what the routine already says — is decided before a row is built and the
// store never sees it.
enum class ProposalMintError { none, idTaken, idReused, unknownRoutine, unknownExercise, noChange };

struct ProposalMintOutcome {
  std::optional<RoutineProposal> proposal;
  ProposalMintError error;
};

// What became of an apply or a dismiss. `superseded`: the base moved since the mint, so the diff
// describes a document that is gone and the proposal is settled as superseded rather than repaired.
// `settled`: a proposal already applied or dismissed is being asked for the OTHER one; asking for
// the state it already holds is a replay and answers with the stored row.
enum class ProposalSettleError { none, notFound, superseded, settled };

struct ProposalSettleOutcome {
  std::optional<RoutineProposal> proposal;
  std::optional<Routine> routine;   // how the routine now stands; absent on a dismiss and a removal
  ProposalSettleError error;
};

// The program's door to gym storage: the routines and the proposal ledger against them, in one port
// because they are written in one transaction — `replaceRoutine` supersedes every pending proposal
// on the routine it rewrites, and `applyRevision` rewrites the routine a proposal was frozen
// against. Every read and write is owner-scoped by the UserId it carries; absent is byte-identical
// to forbidden. insertRoutine and insertProposal are idempotent by client-minted id and answer with
// the row that is stored; replaceRoutine is idempotent by shape, the whole document.
struct ProgramRepository {
  virtual ~ProgramRepository() = default;

  // Both reads carry lastTrainedAtMs, an aggregate over the log rather than a column; its absence is
  // the whole of `untested`.
  virtual std::vector<Routine> routines(const UserId& user) = 0;   // most recently trained first
  virtual std::optional<Routine> routine(const UserId& user, const RoutineId& id) = 0;
  // The routine's dated history, newest first, with its creation row last.
  virtual std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id) = 0;
  // The routine row and its entries land in one transaction. `byAgent` is a fact about the write,
  // not the document — absent is the lifter's own hand, present is the door an agent came through —
  // so a later replace must not rewrite it. `nowMs` dates the creation row from the service's clock,
  // never the database's.
  virtual RoutineWriteOutcome insertRoutine(const Routine& incoming,
                                            std::optional<ProposalDoor> byAgent,
                                            std::uint64_t nowMs) = 0;   // conflict = the stored
  // The whole-document replace, reached by `PUT /v1/gym/routines/{id}` and by no MCP tool at any
  // grant level. It moves the revision and, in the same transaction, supersedes every proposal still
  // pending on that routine. `nowMs` dates those supersessions, from the service's clock.
  virtual RoutineWriteOutcome replaceRoutine(const Routine& incoming, std::uint64_t nowMs,
                                             std::optional<int> expectedRevision) = 0;
  virtual bool deleteRoutine(const UserId& user, const RoutineId& id) = 0;  // false = nothing to remove

  // The proposal ledger. An agent reaches exactly one of these, the mint; the other three are the
  // lifter's. `proposalHeads` carries no diff rows at all; `proposal` is the diff screen's whole
  // read and is the one that fills `loggedSets` on a removed line, counted now rather than at mint.
  virtual std::vector<ProposalHead> proposalHeads(const UserId& user, const ProposalQuery& query) = 0;
  virtual std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id) = 0;
  // One transaction: the proposal row, its lines, and the supersession of whatever was pending from
  // the same door. The routine is resolved under the caller's own scope inside that transaction, and
  // its revision is what the proposal is frozen against.
  virtual ProposalMintOutcome insertProposal(const RoutineProposal& incoming) = 0;
  // Atomic and all-or-none. `becomes` is what the domain computed from the base
  // (domain/Proposal.h); the store re-checks the revision under its own lock and refuses the whole
  // thing if the routine moved between the two.
  virtual ProposalSettleOutcome applyRevision(const UserId& user, const ProposalId& id,
                                              const Routine& becomes, std::uint64_t nowMs) = 0;
  // A removal deletes the routine, so its entries, its sessions' pointers and this proposal's own
  // row go with it (`on delete cascade`); the answer is composed before the delete.
  virtual ProposalSettleOutcome applyRemoval(const UserId& user, const ProposalId& id,
                                             std::uint64_t nowMs) = 0;
  // Nothing changes; the proposal stays in the routine's history.
  virtual ProposalSettleOutcome dismissProposal(const UserId& user, const ProposalId& id,
                                                std::uint64_t nowMs) = 0;
};

}
