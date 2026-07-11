#pragma once

#include "domain/Command.h"
#include "domain/Ids.h"
#include "domain/LooseGraph.h"
#include "domain/Tree.h"
#include "domain/TreeDiagnostics.h"
#include "ports/Op.h"
#include "ports/OpLog.h"
#include "ports/PresenceBus.h"

#include <optional>
#include <set>
#include <string>

namespace wm {

// One editor's command as it reaches the room: the idempotency id, the command, its
// HLC, and who issued it.
struct Incoming {
  std::string opId;
  Command command;
  Hlc hlc;
  UserId actor;
};

// The outcome of a merged command: the op to log/broadcast, plus the inverse computed
// against the pre-merge state (empty for a no-op) so the actor's undo stack can hold it.
struct Applied {
  AppliedOp op;
  std::vector<Command> inverse;
};

// The authority for one tree. Runs on a single strand (supplied by infra), so its
// state is mutated by one thread at a time. It merges every command — never rejects —
// assigns the next seq, persists to the op log, and broadcasts. Validity is a separate
// read model (diagnose()).
class TreeRoom {
public:
  TreeRoom(TreeId id, std::string title, LooseGraph graph, Seq head, OpLog& ops, PresenceBus& bus);

  std::optional<Applied> submit(const Incoming& incoming);

  // Re-apply an op already in the log (loading the tail after a snapshot). Merges and
  // advances head + dedup set, but does not re-persist or re-broadcast.
  void replay(const AppliedOp& op);

  TreeDiagnostics diagnose() const;
  TreeData snapshot() const;
  GraphState exportState() const;
  const std::string& title() const { return title_; }
  Seq head() const { return head_; }

private:
  TreeId id_;
  std::string title_;
  LooseGraph graph_;
  Seq head_;
  std::set<std::string> appliedOpIds_;
  OpLog& ops_;
  PresenceBus& bus_;
};

}
