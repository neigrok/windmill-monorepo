#include "application/TreeRoom.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {

TreeRoom makeRoom(FakeOpLog& log, FakeBus& bus) {
  return TreeRoom(tid(), "Title", LooseGraph{}, 0, log, bus);
}

Incoming in(const char* opId, Command command, std::uint64_t ms) {
  return Incoming{opId, std::move(command), at(ms), uid()};
}

}

TEST(room_applies_command_assigns_seq_persists_broadcasts) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  auto applied = room.submit(in("op1", createNode("a"), 1));
  CHECK(applied.has_value());
  CHECK_EQ(applied->op.seq, static_cast<Seq>(1));
  CHECK_EQ(room.head(), static_cast<Seq>(1));
  CHECK_EQ(log.byTree["t"].size(), 1u);
  CHECK_EQ(bus.broadcasts.size(), 1u);
  CHECK_EQ(room.snapshot().nodes.size(), 1u);
}

TEST(room_dedupes_repeated_opid) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  auto first = room.submit(in("op1", createNode("a"), 1));
  auto echo = room.submit(in("op1", createNode("a"), 1));
  CHECK(first.has_value());
  CHECK_FALSE(echo.has_value());
  CHECK_EQ(room.head(), static_cast<Seq>(1));
  CHECK_EQ(log.byTree["t"].size(), 1u);
}

TEST(room_never_rejects_and_surfaces_cycle) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  room.submit(in("c1", createNode("a"), 1));
  room.submit(in("c2", createNode("b"), 2));
  room.submit(in("e1", AddEdge{nid("a"), nid("b")}, 3));
  auto closing = room.submit(in("e2", AddEdge{nid("b"), nid("a")}, 4));

  CHECK(closing.has_value());
  CHECK_EQ(room.head(), static_cast<Seq>(4));

  auto report = room.diagnose();
  CHECK_FALSE(report.clean());
  CHECK_EQ(report.cycles.size(), 1u);
  CHECK_EQ(report.cycles[0].members.size(), 2u);
}

TEST(room_op_log_replays_since_seq) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  room.submit(in("c1", createNode("a"), 1));
  room.submit(in("c2", createNode("b"), 2));
  room.submit(in("e1", AddEdge{nid("a"), nid("b")}, 3));

  CHECK_EQ(log.since(tid(), 1).size(), 2u);
  CHECK_EQ(log.since(tid(), 0).size(), 3u);
}

TEST(room_returns_inverse_for_undo) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  room.submit(in("c1", createNode("a"), 1));
  auto renamed = room.submit(in("r1", RenameNode{nid("a"), "renamed"}, 2));
  CHECK(renamed.has_value());
  CHECK_EQ(renamed->inverse.size(), 1u);
}
