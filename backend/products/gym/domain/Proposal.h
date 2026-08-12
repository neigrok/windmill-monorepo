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

// ── THE RULE: RECORD OR INTENT ───────────────────────────────────────────────────────────────
//
// Split every write an agent makes by WHAT CLASS OF OBJECT IT TOUCHES, and it is a predicate here
// rather than a list of tool names on purpose: when routine templates or plate profiles arrive in
// 2027 they are classified by what they do, and nobody has to remember to add them to anything. A
// table is what rots.
//
// The log is what already happened. The program is what will happen. The catalog is the vocabulary
// both are written in.
enum class Subject { log, catalog, program };

// Whether the write lands on something that already stands, or brings a new thing into being.
enum class Standing { fresh, existing };

enum class Mutation { record, intent };

// A mutation that RECORDS something that already happened executes immediately, at every door: the
// bar is already back on the rack, the consequence is visible in the room within seconds, and
// confirming a fact is theatre. A mutation that CHANGES something that will happen mints a proposal
// that does nothing until the lifter taps Apply — a rewritten Tuesday speaks to a tired future
// person in a room where the conversation that caused it is gone, and Apply is the only UI that
// decision will ever have.
//
// So: every write to the log is a record however it arrives. Bringing a new day of the program, or
// a new movement, into being takes nothing away and is a record too. Changing or removing one that
// already stands is an intent.
constexpr Mutation classify(Subject subject, Standing standing) {
  if (subject == Subject::log) return Mutation::record;
  if (standing == Standing::fresh) return Mutation::record;
  return Mutation::intent;
}

// ── THE PROPOSAL ─────────────────────────────────────────────────────────────────────────────

// What the whole proposal is for. `revise` carries a document the routine takes on; `remove` says
// this day leaves the program. They are one object rather than two because both wait for the same
// tap, settle into the same dated record, and are read on the same screen.
enum class ProposalIntent { revise, remove };

// Pending until the lifter settles it, and every other state is terminal. `superseded` is what a
// pending proposal becomes when the routine moves underneath it — by the lifter's own hand, or by
// a newer proposal from the same door — because a proposal minted against a document that has
// since changed is merged over the top by nobody. It drops into the routine's dated history rather
// than vanishing: nothing piles up, nothing disappears.
enum class ProposalState { pending, applied, dismissed, superseded };

// Which door it came through. Two doors onto one engine — the lifter's own agent over MCP, and
// gym's own Ask — and the state below is deliberately a COLUMN rather than a fork: "a change
// appeared in my Tuesday and I cannot tell whether it was my Claude or Windmill's coach" is the
// exact mental-model failure this design exists to prevent, and one type is what makes the two
// impossible to tell apart in code and trivial to tell apart on screen.
enum class ProposalDoor { mcp, ask };

// Which door, which connection, which model. `connection` and `agent` are EMPTY today and that is
// a fact about the transport rather than a shrug: `ToolCaller` (platform/domain/ToolScope.h)
// carries the account and the grant and nothing that names one connection apart from another, so
// gym cannot honestly fill either yet. They are columns now so that the day the transport carries
// a connection identity, one line fills them and nothing else moves.
struct ProposalSource {
  ProposalDoor door;
  std::string connection;
  std::string agent;

  bool operator==(const ProposalSource&) const = default;
};

std::string toString(ProposalIntent intent);
std::string toString(ProposalState state);
std::string toString(ProposalDoor door);
ProposalIntent proposalIntentFromStored(std::string_view text);
ProposalState proposalStateFromStored(std::string_view text);
ProposalDoor proposalDoorFromStored(std::string_view text);

// What one line of the program asks for — a routine entry with its identity and its place taken
// off, which is exactly the half of it a diff compares. The absences mean what they mean
// everywhere else: no reps is `max`, no weight is "whatever you did last time", no rest falls back
// to the lifter's global target.
struct EntryTargets {
  int sets;
  std::optional<int> reps;
  std::optional<double> weightKg;
  std::optional<int> restSeconds;

  bool operator==(const EntryTargets&) const = default;
};

EntryTargets targetsOf(const RoutineEntry& entry);

// `kept` is a line the proposal leaves alone, and it is stored beside the other three because the
// rows are the DOCUMENT as well as the diff (see RoutineProposal). A screen draws the other three.
enum class ChangeKind { kept, added, removed, retargeted };

// One row of the typed field-level diff §D14 draws: `sets 5 × 5 → 5 × 3`, `weight 82.5 → 87.5`,
// `+ Incline DB Press · added · 3 × 10 · 24`, `− Cable Fly · removed · 41 logged sets kept`.
//
// `loggedSets` is filled on READ and stored nowhere, for a `removed` row alone: it is the sentence
// that makes a removal safe to read — the lines leave the program and every set logged under them
// stays in the log — and a count frozen at mint would be wrong by the time anybody read it.
struct RoutineChange {
  int position;
  ChangeKind kind;
  ExerciseId exercise;
  std::optional<EntryTargets> before;   // absent for `added`
  std::optional<EntryTargets> after;    // absent for `removed`
  int loggedSets = 0;

  bool operator==(const RoutineChange&) const = default;
};

// The one line a lifter reads before they open the diff, capped where every other free text in
// this product is capped.
constexpr std::size_t kMaxSummaryLength = 400;

// Everything a CARD needs and nothing more — Today's card, the dot on the routines list, and a row
// of the routine editor's History section. The change rows are deliberately not here: a list read
// that carried every diff row of every proposal would be the token budget spent on a screen that
// draws a count.
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
// THE ROWS ARE THE DOCUMENT AS WELL AS THE DIFF, and that is the one structural decision here.
// Rows `1..k` are the run the routine takes on, in order — `kept`, `added` and `retargeted` alike
// — and rows `k+1..n` are the lines the proposal takes away. So there is exactly one stored
// representation: the diff a lifter reads and the document an Apply writes are the same rows read
// two ways, and they cannot drift apart the way a stored diff beside a stored document would.
//
// `baseRevision` and `baseName` are FROZEN at mint, exactly as a session's plan snapshot is. An
// Apply lands only while the routine still stands at that revision; a routine that moved since is
// superseded rather than merged over the top.
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

// The diff, computed once from the two documents and stored. Proposed lines are matched to base
// lines by movement, first unmatched first — so bench heavy followed by bench back-off keeps both
// of its lines, which is the whole reason a routine's key is its position and not its movement.
std::vector<RoutineChange> changesBetween(const std::vector<RoutineEntry>& base,
                                          const std::vector<RoutineEntry>& proposed);

// What `Apply all N` counts: every row that moves, one for a renamed routine, and one for a run the
// proposal REORDERS. A `kept` row is not a change and is not counted — but a day is trained top to
// bottom, so moving squats to the front IS a change, and the rows express it by their order alone.
// Counting it is what keeps "move squats first" from being answered with `nothing to propose`, which
// would be a refusal that is simply untrue.
int countedChanges(const std::vector<RoutineEntry>& base, const std::vector<RoutineChange>& changes,
                   const std::string& baseName, const std::string& proposedName);

// Whether a mint arriving under an id this account has ALREADY SPENT is the replay of what stands
// under it, or a second idea wearing the first one's id. Everything the caller sent is compared —
// the routine, the intent, the door, the summary, the base it was minted against, both names, every
// diff row — and nothing the store decided: the state a lifter has since moved it to, when it was
// minted, and the `loggedSets` counted at read time are not the caller's to match.
//
// A replay answers with the stored proposal. Anything else must be REFUSED, because answering a
// document that was thrown away with a receipt saying "a proposal is waiting in the lifter's app"
// is the unforgivable defect running backwards: an agent that has just told its human it proposed a
// deload would be lying, and the proposal waiting would be somebody else's idea.
bool isReplayOf(const RoutineProposal& stored, const RoutineProposal& incoming);

// The run rows `1..k` describe, renumbered 1..n — the document an Apply writes.
std::vector<RoutineEntry> documentOf(const RoutineProposal& proposal);

// The routine this proposal makes true, built from the base it was minted against. It goes through
// the Routine constructor like every other routine in this product, so a proposal that could not
// be stored as a plan is refused where every malformed value is refused. The revision moves,
// because applying is a write like the lifter's own.
Routine appliedTo(const Routine& base, const RoutineProposal& proposal);

}
