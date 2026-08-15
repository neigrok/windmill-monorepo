#pragma once

#include "platform/ports/Clock.h"
#include "products/gym/ports/ProgramRepository.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// The plan writes. A routine travels as its WHOLE document — a create and a replace send the same
// shape, and the editor's every change is a read-modify-write of it — so there is no per-entry
// route, no reorder verb, and nothing to reconcile between them. Entry positions are the order the
// entries arrive in; the Routine constructor is what refuses anything else.
struct RoutineWrite {
  RoutineId id;
  std::string name;
  int position;
  std::vector<RoutineEntry> entries;
  std::optional<int> expectedRevision;  // the revision the editor read; named → a moved day is refused stale
};

// What an agent proposes: the routine it is about, the document it would take on, the name it would
// carry, and the one sentence a card prints before a lifter opens the diff. The proposal's own id is
// the caller's to mint, exactly as a session's and a set's are, so a lost reply is replayed rather
// than turned into a second proposal that would supersede the first.
//
// There is no `position` here, and its absence is a decision rather than an omission: where a day
// sits in a lifter's week is their ordering of their own life, not a program change an agent
// proposes, so a diff about bench press cannot quietly reshuffle the routines screen.
//
// `source` is provenance — which door, which connection, which model — carried on the write rather
// than inferred later, because W7's Ask mints through this same object and the difference between
// the two doors must be a column and never a fork.
struct ProposalWrite {
  ProposalId id;
  RoutineId routine;
  std::optional<std::string> name;   // absent = the routine keeps the name it has
  std::string summary;
  std::vector<RoutineEntry> entries;
  ProposalSource source;
};

// The application seam over the program — one of five services, each over the aggregate port of the
// same name (TrainingService, CatalogService, ThreadService, PreferencesService are the other four):
// the routines, and the proposal ledger an agent writes into and only a hand settles. Every refusal
// these can answer is the store's own fact, so they hand the port's outcomes straight back rather
// than re-spelling them into a second enum that could only ever say the same words. The store
// validates a routine's movements itself (unknownExercise is its answer), so no catalog port is
// held here; the clock dates every write the server itself decides the instant of.
class ProgramService {
public:
  ProgramService(ProgramRepository& program, Clock& clock);

  std::vector<Routine> routines(const UserId& user);
  std::optional<Routine> routine(const UserId& user, const RoutineId& id);
  // The routine's dated history — its creation and every proposal ever minted against it, in one
  // list (ports/ProgramRepository.h). It rides on the routine's own read rather than on a route of
  // its own, because it is one section of one screen (§M30) and a page that made a call per section
  // draws in stages.
  std::vector<RoutineEvent> routineHistory(const UserId& user, const RoutineId& id);
  // `byAgent` is the door a create came through, absent for the lifter's own hand. It is stated by
  // each caller rather than defaulted: the app's route and the MCP tool are the only two, and a
  // third one that appeared without saying which it was would quietly claim the lifter's.
  RoutineWriteOutcome createRoutine(const UserId& user, const RoutineWrite& incoming,
                                    std::optional<ProposalDoor> byAgent);
  // The PATH names the routine being replaced; the body carries what it becomes.
  //
  // THIS IS THE HUMAN'S HAND, and it is reachable from `PUT /v1/gym/routines/{id}` alone. No MCP
  // tool calls it at any grant level — the tool layer is the only place gym can tell an agent from
  // a hand, and an agent that wants this asks for it through the proposal ledger below. A wave that
  // "completes the catalog" here deletes the whole of §D from the product.
  RoutineWriteOutcome replaceRoutine(const UserId& user, const RoutineId& id,
                                     const RoutineWrite& incoming);
  bool deleteRoutine(const UserId& user, const RoutineId& id);

  // THE PROPOSAL LEDGER — the agent's whole reach into a day of the program that already stands.
  //
  // `propose` is the only one of the four an agent can call. It loads the routine under the
  // caller's own scope, builds the document it would become — through the Routine constructor, so a
  // proposal that could not be stored as a plan is refused at the mint rather than at the tap —
  // asks the pure rule for the typed field-level diff, and stores that against the routine's
  // current revision. Nothing is written to the program.
  //
  // `apply` and `dismiss` are the LIFTER's, reached from two owner-scoped routes and from no tool
  // at any level, because Apply is not a capability. `apply` is atomic: the domain computes the
  // routine the proposal makes true, the store writes it against the frozen base revision, and a
  // routine that moved since is superseded rather than merged over the top.
  std::vector<ProposalHead> proposals(const UserId& user, const ProposalQuery& query);
  std::optional<RoutineProposal> proposal(const UserId& user, const ProposalId& id);
  ProposalMintOutcome propose(const UserId& user, const ProposalWrite& incoming);
  ProposalMintOutcome proposeRemoval(const UserId& user, const ProposalId& id,
                                     const RoutineId& routine, const std::string& summary,
                                     const ProposalSource& source);
  ProposalSettleOutcome apply(const UserId& user, const ProposalId& id);
  ProposalSettleOutcome dismiss(const UserId& user, const ProposalId& id);

private:
  ProgramRepository& program_;
  Clock& clock_;
};

}
