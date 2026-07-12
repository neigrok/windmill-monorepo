#include "application/TreeRoom.h"
#include "test/application/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {

TreeRoom makeRoom(FakeOpLog& log, FakeBus& bus) {
  return TreeRoom(tid(), "Title", LooseGraph{}, Legend{}, 0, log, bus);
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

TEST(room_snapshot_carries_the_legend) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  room.submit(in("k1", AddKind{KindId{"sky"}, NodeColor::sky}, 1));
  room.submit(in("k2", RenameKind{KindId{"sky"}, "Infra"}, 2));

  TreeData snapshot = room.snapshot();
  CHECK_EQ(snapshot.kinds.size(), 1u);
  CHECK_EQ(snapshot.kinds[0].id, KindId{"sky"});
  CHECK_EQ(snapshot.kinds[0].hue, NodeColor::sky);
  CHECK_EQ(snapshot.kinds[0].label, std::string("Infra"));
}

TEST(room_validate_rejects_invalid_legend_ops_only) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  room.submit(in("k1", AddKind{KindId{"sky"}, NodeColor::sky}, 1));
  CHECK(room.validate(AddKind{KindId{"dupe"}, NodeColor::sky}).has_value());   // hue taken
  CHECK_FALSE(room.validate(AddKind{KindId{"gold"}, NodeColor::gold}).has_value());
  CHECK_FALSE(room.validate(RenameNode{nid("anything"), "x"}).has_value());    // graph op: never rejected
}

TEST(room_recolor_kind_repaints_nodes) {
  FakeOpLog log;
  FakeBus bus;
  TreeRoom room = makeRoom(log, bus);

  room.submit(Incoming{"n1", CreateNode{nid("a"), "A", "i", NodeColor::olive, std::nullopt, std::nullopt}, at(1), uid()});
  room.submit(in("k1", AddKind{KindId{"learn"}, NodeColor::olive}, 2));
  room.submit(in("rc", RecolorKind{KindId{"learn"}, NodeColor::brick}, 3));

  TreeData snapshot = room.snapshot();
  CHECK_EQ(snapshot.nodes.size(), 1u);
  CHECK_EQ(snapshot.nodes[0].color, NodeColor::brick);   // node followed its kind
  CHECK_EQ(snapshot.kinds[0].hue, NodeColor::brick);
}
