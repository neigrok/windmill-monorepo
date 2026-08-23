#pragma once

#include "products/gym/domain/Routine.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

struct ProposalTag;
using ProposalId = Id<ProposalTag>;

// What class of object a write touches. The log is what already happened, the program is what will
// happen, the catalog is the vocabulary both are written in.
enum class Subject { log, catalog, program };

// Whether the write lands on something that already stands, or brings a new thing into being.
enum class Standing { fresh, existing };

enum class Mutation { record, intent };

// A `record` executes immediately at every door. An `intent` mints a proposal that does nothing
// until the lifter taps Apply.
constexpr Mutation classify(Subject subject, Standing standing) {
  if (subject == Subject::log) return Mutation::record;
  if (standing == Standing::fresh) return Mutation::record;
  return Mutation::intent;
}

// `revise` carries a document the routine takes on; `remove` says this day leaves the program.
enum class ProposalIntent { revise, remove };

// Pending until the lifter settles it; every other state is terminal. `superseded` is what a pending
// proposal becomes when the routine moves underneath it — nothing is merged over the top, and the
// proposal stays in the routine's dated history.
enum class ProposalState { pending, applied, dismissed, superseded };

// Which door it came through: the lifter's own agent over MCP, or gym's own Ask.
enum class ProposalDoor { mcp, ask };

// The conversation a proposal was minted in; the thread itself is `domain/Thread.h`, which includes
// this file.
struct AskThreadTag;
using ThreadId = Id<AskThreadTag>;

// `connection` and `agent` are empty: `ToolCaller` (platform/domain/ToolScope.h) carries nothing
// that names one connection apart from another. `thread` is absent from the MCP door, and absent
// again once the lifter deletes the thread an Ask proposal came from — both mean there is nothing
// here to open.
struct ProposalSource {
  ProposalDoor door;
  std::string connection;
  std::string agent;
  std::optional<ThreadId> thread;

  bool operator==(const ProposalSource&) const = default;
};

std::string toString(ProposalIntent intent);
std::string toString(ProposalState state);
std::string toString(ProposalDoor door);
ProposalIntent proposalIntentFromStored(std::string_view text);
ProposalState proposalStateFromStored(std::string_view text);
ProposalDoor proposalDoorFromStored(std::string_view text);

// A routine entry with its identity and its place taken off — the half a diff compares. Absences
// carry their usual meaning: no sets is an open line, no reps is `max`, no weight is "whatever you
// did last time", no rest falls back to the global target. Only `kind` says which side of a diff is
// missing, never an absent `sets`.
struct EntryTargets {
  std::optional<int> sets;
  std::optional<int> reps;
  std::optional<double> weightKg;
  std::optional<int> restSeconds;

  bool operator==(const EntryTargets&) const = default;
};

EntryTargets targetsOf(const RoutineEntry& entry);

// `kept` is a line the proposal leaves alone, stored because the rows are the document as well as
// the diff (see RoutineProposal); a screen draws the other three.
enum class ChangeKind { kept, added, removed, retargeted };

// One row of the typed field-level diff. `loggedSets` is filled on READ and stored nowhere, for a
// `removed` row alone.
struct RoutineChange {
  int position;
  ChangeKind kind;
  ExerciseId exercise;
  std::optional<EntryTargets> before;   // absent for `added`
  std::optional<EntryTargets> after;    // absent for `removed`
  int loggedSets = 0;

  bool operator==(const RoutineChange&) const = default;
};

// The one line a lifter reads before opening the diff.
constexpr std::size_t kMaxSummaryLength = 400;

// Everything a card needs and nothing more; the diff rows are deliberately not here.
struct ProposalHead {
  ProposalId id;
  RoutineId routine;
  UserId user;
  ProposalIntent intent;
  ProposalState state;
  ProposalSource source;
  std::string summary;
  int changes;             // what `Apply all N` counts: the rows that move, plus a renamed name
  std::uint64_t createdAtMs;
  std::optional<std::uint64_t> settledAtMs;

  bool operator==(const ProposalHead&) const = default;
};

// A proposal, whole: its head, the base it was minted against, and the typed diff.
//
// The rows are the document as well as the diff: rows `1..k` are the run the routine takes on, in
// order — `kept`, `added` and `retargeted` alike — and rows `k+1..n` are the lines it takes away.
//
// `baseRevision` and `baseName` are frozen at mint. An Apply lands only while the routine still
// stands at that revision.
struct RoutineProposal {
  ProposalHead head;
  int baseRevision;
  std::string baseName;
  std::string proposedName;
  std::vector<RoutineChange> changes;

  RoutineProposal(ProposalHead head, int baseRevision, std::string baseName,
                  std::string proposedName, std::vector<RoutineChange> changes);

  bool operator==(const RoutineProposal&) const = default;
};

// Computed once from the two documents and stored. Proposed lines are matched to base lines by
// movement, first unmatched first, so a movement appearing twice keeps both of its lines.
std::vector<RoutineChange> changesBetween(const std::vector<RoutineEntry>& base,
                                          const std::vector<RoutineEntry>& proposed);

// What `Apply all N` counts: every row that moves, one for a renamed routine, and one for a run the
// proposal reorders. A `kept` row is not counted, but a reorder of kept rows is.
int countedChanges(const std::vector<RoutineEntry>& base, const std::vector<RoutineChange>& changes,
                   const std::string& baseName, const std::string& proposedName);

// Whether a mint under an already-spent id is the replay of what stands under it. Everything the
// caller sent is compared — routine, intent, door, summary, base, both names, every diff row — and
// nothing the store decided: state, mint instant and read-time `loggedSets` are not the caller's to
// match. A replay answers with the stored proposal; anything else must be refused.
bool isReplayOf(const RoutineProposal& stored, const RoutineProposal& incoming);

// The run rows `1..k` describe, renumbered 1..n — the document an Apply writes.
std::vector<RoutineEntry> documentOf(const RoutineProposal& proposal);

// The routine this proposal makes true, built from the base through the Routine constructor so a
// proposal that could not be stored as a plan is refused there. The revision moves.
Routine appliedTo(const Routine& base, const RoutineProposal& proposal);

}
