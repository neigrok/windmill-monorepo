#pragma once

#include "products/gym/domain/Proposal.h"
#include "products/gym/domain/Routine.h"
#include "products/gym/domain/Training.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// What became of a routine write, under the same rule as LogRepository's insertSet: every refusal the store alone
// can know crosses as a VALUE, never as a vendor exception the wire layer would have to name. One
// outcome serves both writes because a routine write has one shape — the whole document — and each
// of the two producers can raise only what it can see: insertRoutine answers idTaken (the id is
// spent on a row this account does not own, never whose) and replaceRoutine answers notFound
// (absent and another account's are the same fact). unknownExercise is either one's, and it is the
// same fact a set's write states under the same predicate: an entry names a movement this account's
// catalog does not hold.
enum class RoutineWriteError { none, idTaken, notFound, unknownExercise };

struct RoutineWriteOutcome {
  std::optional<Routine> routine;
  RoutineWriteError error;
};

// What a surface is asking the proposal ledger for. Today's card reads the pending ones across
// every routine; the dot on the routines list reads one routine's pending, because an applied or
// dismissed proposal is part of the program's history rather than a toast that disappeared — and
// that history is now read through `routineHistory` below rather than through this query.
struct ProposalQuery {
  std::optional<RoutineId> routine;
  bool pendingOnly = false;

  bool operator==(const ProposalQuery&) const = default;
};

// One dated row of a routine's own history (§M30's `9 Aug · created by you · 4 movements`), and
// BOTH kinds of thing that happen to a day of the program ride in it: the day being created, and
// every proposal an agent has ever minted against it. One shape and one read, because a screen
// handed two lists would have to merge them by date itself — three surfaces, three merges, and
// three chances to date the same event differently.
//
// Each kind carries its own descriptor and nothing carries two meanings. `proposal` is present
// exactly when kind is `proposal`, and the actor of one is inside it (`source.door`). `door` and
// `movements` belong to the CREATED row alone: an absent door is the lifter's own hand — the case
// §M is about — and `movements` is how many lines the day was created with, which is a fact only
// the write that created it could record, so it is absent on rows written before this wave rather
// than backfilled from a document that has been edited since.
enum class RoutineEventKind { created, proposal };

struct RoutineEvent {
  RoutineEventKind kind;
  std::uint64_t atMs;
  std::optional<ProposalDoor> door;       // created only; absent = the lifter's own hand
  std::optional<int> movements;           // created only; absent = never recorded
  std::optional<ProposalHead> proposal;   // present exactly when kind == proposal

  bool operator==(const RoutineEvent&) const = default;
};

// How far back a routine's history reads. The creation row is always the last one and never counts
// against this — it is the anchor of the list, and it is one row of the routine's own record — so
// this bounds the proposals above it. A ledger nobody scrolls to the end of does not need a
// lifetime of rows in it, the same bound `kRecentDays` makes on the record page.
constexpr int kRoutineHistoryProposals = 20;

// What became of a mint, under the same rule every other write in this port obeys: each refusal is
// the store's own fact and crosses as a VALUE.
//
// THE SPENT ID SPLITS THREE WAYS, and conflating any two of them is how a mint lies. `idTaken` is
// the id spent on a proposal this account cannot see. The caller's OWN id, carrying the SAME
// document, is not a refusal at all — it is the replay, and the stored proposal comes back
// untouched, so an agent that lost a reply resends the same id instead of minting a second proposal
// that would supersede its own first. The caller's own id carrying a DIFFERENT document is
// `idReused`: two ideas cannot share one id, and answering the second with the first is a receipt
// that says "your proposal is waiting" about somebody else's proposal.
//
// `unknownRoutine` is absent and another account's alike. `unknownExercise` is refused HERE rather
// than at apply, which is the whole point of refusing it at all: a proposal a lifter cannot apply
// must never reach their screen. `noChange` is the one refusal the STORE never sees, because it is
// decided before a row is built: a document identical to what the routine already says is a card
// that would read `Apply all 0`, and putting one in a lifter's product is not nothing — it is a
// notification about nothing, in an app that has no notifications on purpose.
enum class ProposalMintError { none, idTaken, idReused, unknownRoutine, unknownExercise, noChange };

struct ProposalMintOutcome {
  std::optional<RoutineProposal> proposal;
  ProposalMintError error;
};

// What became of an apply or a dismiss. `superseded` is the base having moved since the mint — the
// lifter's own hand, or a newer proposal — and it is the one refusal that is not the caller's
// fault and not repairable: the diff describes a document that is gone, so it is settled as
// superseded and the lifter reads the routine as it now stands. `settled` is a proposal already
// applied or already dismissed being asked for the OTHER one; asking for the state it already
// holds is a replay and answers with the stored row.
enum class ProposalSettleError { none, notFound, superseded, settled };

struct ProposalSettleOutcome {
  std::optional<RoutineProposal> proposal;
  std::optional<Routine> routine;   // how the routine now stands; absent on a dismiss and a removal
  ProposalSettleError error;
};

// The program's door to gym storage: the routines and the proposal ledger against them, in ONE
// port because they are written in one transaction — `replaceRoutine` supersedes every pending
// proposal on the routine it rewrites, `applyRevision` rewrites the routine a proposal was frozen
// against, and a store that held them in two ports would hold that lock order in two places. One
// of five aggregate ports over one Postgres database (LogRepository, CatalogRepository,
// AskThreadRepository, PreferencesRepository are the others). Every read and write is owner-scoped
// by the UserId it carries; absent is byte-identical to forbidden. insertRoutine and insertProposal
// are idempotent by client-minted id and answer with the row that is stored; replaceRoutine is
// idempotent by shape, the whole document.
struct ProgramRepository {
  virtual ~ProgramRepository() = default;

  // The plan. Both reads carry lastTrainedAtMs, which is an aggregate over the log rather than a
  // column, so the list can sort by the thing the routines screen sorts by and one routine can say
  // the same word as its row in that list — and it is also the whole of `untested` (§M30): a
  // routine that has never been trained has no newest session to name, so the absence IS the badge
  // and no flag is stored that a discarded workout could leave standing.
  virtual std::vector<Routine> routines(const UserId& user) = 0;   // most recently trained first
  virtual std::optional<Routine> routine(const UserId& user, const RoutineId& id) = 0;
  // The routine's dated history, newest first, with its creation row last. It is one read over two
  // tables rather than a list per kind, for the reason RoutineEvent gives.
  virtual std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id) = 0;
  // The routine row and its entries land in ONE transaction — the two writes are one document, and
  // a routine with no entries is a plan the domain refuses to build and the editor cannot draw.
  //
  // `byAgent` is who made the day, and it is an argument rather than a field on the entity because
  // it is a fact about the WRITE and not about the document: a later replace carries the same
  // document from a different hand and must not rewrite who created it. Absent is the lifter's own
  // — the app's create, which is every create §M is about — and present is the door an agent's
  // `create_routine` came through. `nowMs` dates the creation row from the one clock the service
  // holds rather than from the database's, exactly as the proposal ledger's mint does, so a test
  // can drive it.
  virtual RoutineWriteOutcome insertRoutine(const Routine& incoming,
                                            std::optional<ProposalDoor> byAgent,
                                            std::uint64_t nowMs) = 0;   // conflict = the stored
  // The whole-document replace, and THE HUMAN'S HAND: this is what `PUT /v1/gym/routines/{id}`
  // reaches, and no MCP tool reaches it at any grant level. It moves the revision and, in the SAME
  // transaction, supersedes every proposal still pending on that routine — which is what stops the
  // mid-session "Save 87.5 to Push A" from silently destroying a proposal's base. `nowMs` is the
  // instant those supersessions are dated by, read from the one clock the service holds rather than
  // from the database's, so a test can drive it.
  virtual RoutineWriteOutcome replaceRoutine(const Routine& incoming, std::uint64_t nowMs) = 0;
  virtual bool deleteRoutine(const UserId& user, const RoutineId& id) = 0;  // false = nothing to remove

  // THE PROPOSAL LEDGER. An agent reaches exactly one of these — the mint — and the other three are
  // the lifter's, because Apply is not a capability, it is a human act.
  //
  // The two reads split by what a screen needs: `proposalHeads` is what a CARD draws (Today's
  // pending card, the dot on the routines list, a row of the routine editor's History), and it
  // carries no diff rows at all, because a list that shipped every diff of every proposal would be
  // the token budget spent on a screen that prints a count. `proposal` is the diff screen's whole
  // read, and it is the one that fills `loggedSets` on a removed line — that count is what makes a
  // removal safe to read, and frozen at mint it would be wrong by the time anybody read it.
  virtual std::vector<ProposalHead> proposalHeads(const UserId& user, const ProposalQuery& query) = 0;
  virtual std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id) = 0;
  // The mint, in ONE transaction: the proposal row, its lines, and the supersession of whatever was
  // pending from the same door. Idempotent by the client-minted id like every other write here — a
  // replay reads back the stored proposal rather than minting a second one that would supersede the
  // first. The routine is resolved under the caller's own scope inside that transaction, and its
  // revision is what the proposal is frozen against.
  virtual ProposalMintOutcome insertProposal(const RoutineProposal& incoming) = 0;
  // The apply, atomic and all-or-none, and the only place a proposal becomes a write. `becomes` is
  // what the DOMAIN computed from the base (domain/Proposal.h) — the store re-checks the revision
  // under its own lock and refuses the whole thing if the routine moved between the two, which is
  // the optimistic half of the same token the mint froze.
  virtual ProposalSettleOutcome applyRevision(const UserId& user, const ProposalId& id,
                                              const Routine& becomes, std::uint64_t nowMs) = 0;
  // The other intent, and its own verb rather than a null `becomes` on the one above: a removal
  // deletes the routine, so its entries, its sessions' pointers and this very proposal's own row go
  // with it (`on delete cascade`). The answer is composed before the delete, because after it there
  // is nothing left to read back.
  virtual ProposalSettleOutcome applyRemoval(const UserId& user, const ProposalId& id,
                                             std::uint64_t nowMs) = 0;
  // No reason is asked for and nothing changes — the proposal stays in the routine's history in
  // case the lifter wants it back.
  virtual ProposalSettleOutcome dismissProposal(const UserId& user, const ProposalId& id,
                                                std::uint64_t nowMs) = 0;
};

}
