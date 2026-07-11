#include "application/TreeRoom.h"
#include "application/UndoService.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

#include <string>

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

TEST(undo_stack_records_and_pops_lifo) {
  UndoService undo;
  undo.record(uid(), {RenameNode{nid("a"), "first"}});
  undo.record(uid(), {RenameNode{nid("a"), "second"}});
  CHECK_EQ(undo.depth(uid()), 2u);

  auto top = undo.pop(uid());
  CHECK(top.has_value());
  CHECK_EQ(top->size(), 1u);
  CHECK_EQ(undo.depth(uid()), 1u);
}

TEST(undo_ignores_empty_inverse) {
  UndoService undo;
  undo.record(uid(), {});
  CHECK_EQ(undo.depth(uid()), 0u);
  CHECK_FALSE(undo.pop(uid()).has_value());
}

TEST(undo_restores_prior_label_through_the_room) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room(tid(), "T", LooseGraph{}, 0, log, bus);
  UndoService undo;

  room.submit(Incoming{"c1", createNode("x"), at(1), uid()});
  auto renamed = room.submit(Incoming{"r1", RenameNode{nid("x"), "Y"}, at(2), uid()});
  undo.record(uid(), renamed->inverse);
  CHECK_EQ(labelOf(room.snapshot(), nid("x")), std::string("Y"));

  auto inverse = undo.pop(uid());
  CHECK(inverse.has_value());
  int step = 0;
  for (const Command& command : *inverse) {
    room.submit(Incoming{"u" + std::to_string(step++), command, at(3), uid()});
  }
  CHECK_EQ(labelOf(room.snapshot(), nid("x")), std::string("x"));
}
