#include "products/gym/domain/Proposal.h"

#include <algorithm>
#include <cstddef>
#include <utility>

namespace wm::gym {

std::string toString(ProposalIntent intent) {
  if (intent == ProposalIntent::remove) return "remove";
  return "revise";
}

std::string toString(ProposalState state) {
  if (state == ProposalState::applied) return "applied";
  if (state == ProposalState::dismissed) return "dismissed";
  if (state == ProposalState::superseded) return "superseded";
  return "pending";
}

std::string toString(ProposalDoor door) {
  if (door == ProposalDoor::ask) return "ask";
  return "mcp";
}

// Clamped on read so a word written by a newer deploy cannot crash an older reader, and clamped to
// the safe reading: an unknown intent is a revision, an unknown state is settled, so nothing a
// reader cannot name is offered as a live tap.
ProposalIntent proposalIntentFromStored(std::string_view text) {
  if (text == "remove") return ProposalIntent::remove;
  return ProposalIntent::revise;
}

ProposalState proposalStateFromStored(std::string_view text) {
  if (text == "pending") return ProposalState::pending;
  if (text == "applied") return ProposalState::applied;
  if (text == "dismissed") return ProposalState::dismissed;
  return ProposalState::superseded;
}

ProposalDoor proposalDoorFromStored(std::string_view text) {
  if (text == "ask") return ProposalDoor::ask;
  return ProposalDoor::mcp;
}

EntryTargets targetsOf(const RoutineEntry& entry) {
  return EntryTargets{entry.targetSets, entry.targetReps, entry.targetWeightKg, entry.restSeconds};
}

RoutineProposal::RoutineProposal(ProposalHead head, int baseRevision, std::string baseName,
                                 std::string proposedName, std::vector<RoutineChange> changes)
    : head(std::move(head)), baseRevision(baseRevision), baseName(trimmedName(std::move(baseName))),
      proposedName(trimmedName(std::move(proposedName))), changes(std::move(changes)) {
  if (!wellFormedId(this->head.id.str())) throw InvalidTraining("bad proposal id");
  if (this->head.routine.empty()) throw InvalidTraining("a proposal names a routine");
  if (this->head.user.empty()) throw InvalidTraining("a proposal belongs to an account");
  if (this->head.summary.size() > kMaxSummaryLength)
    throw InvalidTraining("proposal summary too long");
  if (!storableText(this->head.summary))
    throw InvalidTraining("a proposal summary must be storable text");
  if (this->head.createdAtMs == 0 || this->head.createdAtMs > kMaxInstantMs)
    throw InvalidTraining("a proposal was minted at an instant");
  if (this->head.settledAtMs &&
      (*this->head.settledAtMs == 0 || *this->head.settledAtMs > kMaxInstantMs))
    throw InvalidTraining("a proposal was settled at an instant");
  if (baseRevision < 1) throw InvalidTraining("a proposal stands on a revision from 1");
  // Both names are display names and go through the display-name rule, then the column's ceiling.
  if (this->baseName.empty() || this->proposedName.empty())
    throw InvalidTraining("a proposal names the routine on both sides");
  if (this->baseName.size() > kMaxNameLength || this->proposedName.size() > kMaxNameLength)
    throw InvalidTraining("routine name too long");
  if (!storableText(this->proposedName))
    throw InvalidTraining("a routine name must be storable text");
  if (this->changes.empty()) throw InvalidTraining("a proposal changes something");
  if (this->changes.size() > static_cast<std::size_t>(kMaxRoutineEntries) * 2)
    throw InvalidTraining("a proposal holds too many lines");
  // Dense and 1-based against arrival order, and the run comes first with the lines it takes away
  // last, so rows 1..k are the document.
  bool taking = false;
  int standing = 0;
  for (std::size_t at = 0; at < this->changes.size(); ++at) {
    const RoutineChange& change = this->changes[at];
    if (change.position != static_cast<int>(at) + 1)
      throw InvalidTraining("proposal positions run 1..n in order");
    if (change.exercise.empty()) throw InvalidTraining("a proposal line names an exercise");
    if (change.kind == ChangeKind::removed) {
      taking = true;
      if (!change.before || change.after)
        throw InvalidTraining("a removed line carries what it was and nothing it becomes");
      continue;
    }
    if (taking) throw InvalidTraining("a proposal's removed lines come last");
    ++standing;
    if (!change.after) throw InvalidTraining("a standing line carries what it becomes");
    if (change.kind == ChangeKind::added && change.before)
      throw InvalidTraining("an added line was nothing before");
    if (change.kind != ChangeKind::added && !change.before)
      throw InvalidTraining("a line that stood carries what it was");
  }
  // A revision leaves a plan behind; a removal leaves none.
  if (this->head.intent == ProposalIntent::revise && standing == 0)
    throw InvalidTraining("a revision leaves a routine with at least one movement");
  if (this->head.intent == ProposalIntent::remove && standing != 0)
    throw InvalidTraining("a removal leaves no movement standing");
}

// Proposed lines are matched to base lines by movement, first unmatched first, so two lines naming
// one movement stay two lines. The base lines nothing matched are what the proposal takes away, and
// they come last so the rows read as the document they describe (RoutineProposal).
std::vector<RoutineChange> changesBetween(const std::vector<RoutineEntry>& base,
                                          const std::vector<RoutineEntry>& proposed) {
  std::vector<bool> matched(base.size(), false);
  std::vector<RoutineChange> changes;
  for (const RoutineEntry& line : proposed) {
    const int position = static_cast<int>(changes.size()) + 1;
    std::optional<EntryTargets> before;
    for (std::size_t at = 0; at < base.size(); ++at) {
      if (matched[at] || !(base[at].exercise == line.exercise)) continue;
      matched[at] = true;
      before = targetsOf(base[at]);
      break;
    }
    const EntryTargets after = targetsOf(line);
    if (!before) {
      changes.push_back(RoutineChange{position, ChangeKind::added, line.exercise, std::nullopt,
                                      after, 0});
      continue;
    }
    const ChangeKind kind = *before == after ? ChangeKind::kept : ChangeKind::retargeted;
    changes.push_back(RoutineChange{position, kind, line.exercise, before, after, 0});
  }
  for (std::size_t at = 0; at < base.size(); ++at) {
    if (matched[at]) continue;
    changes.push_back(RoutineChange{static_cast<int>(changes.size()) + 1, ChangeKind::removed,
                                    base[at].exercise, targetsOf(base[at]), std::nullopt, 0});
  }
  return changes;
}

int countedChanges(const std::vector<RoutineEntry>& base, const std::vector<RoutineChange>& changes,
                   const std::string& baseName, const std::string& proposedName) {
  int counted = baseName == proposedName ? 0 : 1;
  for (const RoutineChange& change : changes)
    if (change.kind != ChangeKind::kept) ++counted;

  // The reorder, which the rows say by their order alone. Surviving lines are matched back to the
  // base as changesBetween matched them, and the run moved if those base lines do not come out in
  // base order. A line dropped from the middle is not a reorder; added lines consume nothing.
  std::vector<bool> matched(base.size(), false);
  int highest = -1;
  for (const RoutineChange& change : changes) {
    if (change.kind == ChangeKind::added || change.kind == ChangeKind::removed) continue;
    for (std::size_t at = 0; at < base.size(); ++at) {
      if (matched[at] || !(base[at].exercise == change.exercise)) continue;
      matched[at] = true;
      if (static_cast<int>(at) < highest) return counted + 1;
      highest = static_cast<int>(at);
      break;
    }
  }
  return counted;
}

bool isReplayOf(const RoutineProposal& stored, const RoutineProposal& incoming) {
  if (!(stored.head.id == incoming.head.id)) return false;
  if (!(stored.head.routine == incoming.head.routine)) return false;
  if (stored.head.intent != incoming.head.intent) return false;
  // The door, the connection and the model, but NOT the thread: deleting a conversation clears it,
  // and a replay arriving after that delete is still the same proposal.
  if (stored.head.source.door != incoming.head.source.door) return false;
  if (stored.head.source.connection != incoming.head.source.connection) return false;
  if (stored.head.source.agent != incoming.head.source.agent) return false;
  if (stored.head.summary != incoming.head.summary) return false;
  if (stored.baseRevision != incoming.baseRevision) return false;
  if (stored.baseName != incoming.baseName) return false;
  if (stored.proposedName != incoming.proposedName) return false;
  if (stored.changes.size() != incoming.changes.size()) return false;
  for (std::size_t at = 0; at < stored.changes.size(); ++at) {
    const RoutineChange& held = stored.changes[at];
    const RoutineChange& sent = incoming.changes[at];
    // Every field except `loggedSets`, which is counted at read time and no caller ever sent.
    if (held.position != sent.position || held.kind != sent.kind) return false;
    if (!(held.exercise == sent.exercise)) return false;
    if (held.before != sent.before || held.after != sent.after) return false;
  }
  return true;
}

std::vector<RoutineEntry> documentOf(const RoutineProposal& proposal) {
  std::vector<RoutineEntry> entries;
  for (const RoutineChange& change : proposal.changes) {
    if (change.kind == ChangeKind::removed) break;   // the rows past here are what it takes away
    entries.push_back(RoutineEntry{static_cast<int>(entries.size()) + 1, change.exercise,
                                   change.after->sets, change.after->reps, change.after->weightKg,
                                   change.after->restSeconds});
  }
  return entries;
}

// The id, the owner, where the day sits in the week and when it was last trained stay the base's; a
// proposal changes the document and the name and nothing else.
Routine appliedTo(const Routine& base, const RoutineProposal& proposal) {
  return Routine{base.id,          base.user,          proposal.proposedName, base.position,
                 documentOf(proposal), base.lastTrainedAtMs, base.revision + 1};
}

}
