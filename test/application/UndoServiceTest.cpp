#include "application/TreeRoom.h"
#include "application/UndoService.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

#include <string>
#include <variant>

using namespace wm;
using namespace wm::fake;

namespace {
std::string labelOf(const TreeData& data, const NodeId& id) {
  for (const NodeSpec& node : data.nodes) {
    if (node.id == id) return node.label;
  }
  return "";
}
}

TEST(undo_take_is_lifo) {
  UndoService undos;
  undos.record("k", {RenameNode{nid("a"), "first"}});
  undos.record("k", {RenameNode{nid("a"), "second"}});

  auto top = undos.takeUndo("k");
  CHECK(top.has_value());
  CHECK_EQ(std::get<RenameNode>((*top)[0]).label, std::string("second"));
  auto next = undos.takeUndo("k");
  CHECK_EQ(std::get<RenameNode>((*next)[0]).label, std::string("first"));
  CHECK_FALSE(undos.takeUndo("k").has_value());
}

TEST(record_clears_redo_trail) {
  UndoService undos;
  undos.pushRedo("k", {AddEdge{nid("a"), nid("b")}});
  undos.record("k", {RenameNode{nid("a"), "x"}});  // a fresh edit invalidates redo
  CHECK_FALSE(undos.takeRedo("k").has_value());
}

TEST(undo_keys_are_independent) {
  UndoService undos;
  undos.record("tree1\nuser", {RenameNode{nid("a"), "x"}});
  CHECK_FALSE(undos.takeUndo("tree2\nuser").has_value());
  CHECK(undos.takeUndo("tree1\nuser").has_value());
}

TEST(empty_inverse_not_recorded) {
  UndoService undos;
  undos.record("k", {});
  CHECK_FALSE(undos.takeUndo("k").has_value());
}

TEST(undo_then_redo_through_the_room) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room(tid(), "T", LooseGraph{}, Legend{}, 0, log, bus);
  UndoService undos;

  room.submit(Incoming{"c1", createNode("x"), at(1), uid()});
  auto renamed = room.submit(Incoming{"r1", RenameNode{nid("x"), "Y"}, at(2), uid()});
  undos.record("k", renamed->inverse);
  CHECK_EQ(labelOf(room.snapshot(), nid("x")), std::string("Y"));

  // undo: replay the inverse, stash the counter-inverse for redo
  auto undoGroup = undos.takeUndo("k");
  CHECK(undoGroup.has_value());
  std::vector<Command> redo;
  for (const Command& cmd : *undoGroup) {
    auto applied = room.submit(Incoming{"u1", cmd, at(3), uid()});
    redo.insert(redo.begin(), applied->inverse.begin(), applied->inverse.end());
  }
  undos.pushRedo("k", std::move(redo));
  CHECK_EQ(labelOf(room.snapshot(), nid("x")), std::string("x"));

  // redo: replay the counter-inverse
  auto redoGroup = undos.takeRedo("k");
  CHECK(redoGroup.has_value());
  for (const Command& cmd : *redoGroup) room.submit(Incoming{"rd1", cmd, at(4), uid()});
  CHECK_EQ(labelOf(room.snapshot(), nid("x")), std::string("Y"));
}
