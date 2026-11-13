#include "products/roadmap/adapters/postgres/PgOpLog.h"

#include "platform/adapters/json/JsonText.h"
#include "products/roadmap/adapters/json/CommandJson.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "products/roadmap/application/RoomRegistry.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/PgTestPool.h"
#include "test/products/roadmap/Fakes.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <stdexcept>
#include <string>

// The op log against the real table: opt-in, runs only when WM_PG_TEST is set.
using namespace wm;
using namespace wm::fake;

namespace {

const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";
const TreeId kTree{std::string("pgtest-op-log")};
const UserId kOwner{std::string("00000000-0000-4000-8000-0000000000a1")};

// The real log behind a connection that drops AFTER the row committed: the append throws, the row
// is there, and the caller cannot tell the two apart.
struct DroppingPgOpLog : OpLog {
  PgOpLog inner{pgTestPool()};
  bool dropNext = false;
  void append(const TreeId& tree, const AppliedOp& op) override {
    inner.append(tree, op);
    if (!dropNext) return;
    dropNext = false;
    throw std::runtime_error("connection dropped after commit");
  }
  std::vector<AppliedOp> since(const TreeId& tree, Seq afterSeq) const override { return inner.since(tree, afterSeq); }
  LogPast past(const TreeId& tree, Seq head) const override { return inner.past(tree, head); }
};

void reset() {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  txn.exec_params("INSERT INTO users(id,email) VALUES($1::uuid,'pg-op-log@example.test') ON CONFLICT(id) DO NOTHING", kOwner.str());
  for (const char* table : {"tree_ops", "tree_nodes", "tree_edges", "tree_kinds"})
    txn.exec_params(std::string("DELETE FROM ") + table + " WHERE tree_id = $1", kTree.str());
  txn.exec_params("DELETE FROM trees WHERE id = $1", kTree.str());
  txn.commit();
}

long rowCount() {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  return txn.exec_params("SELECT count(*) FROM tree_ops WHERE tree_id = $1", kTree.str())[0][0].as<long>();
}

AppliedOp opAt(Seq seq, const char* opId) {
  AppliedOp op;
  op.seq = seq;
  op.opId = opId;
  op.command = createNode("a");
  op.hlc = Hlc{10, 0, "srv"};
  op.actor = kOwner;
  return op;
}

}

// The uniqueness the retry leans on: a row re-sent under the same op id is absorbed, not doubled.
TEST(pg_op_log_absorbs_a_row_re_sent_after_a_commit_then_drop) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository repo{pgTestPool()};
  repo.create(kTree, LooseGraph().exportState(), LegendState{}, "Op log", kOwner);
  PgOpLog log{pgTestPool()};

  log.append(kTree, opAt(1, "op-1"));
  log.append(kTree, opAt(1, "op-1"));
  CHECK_EQ(rowCount(), 1L);
  REQUIRE_EQ(log.since(kTree, 0).size(), 1u);
  CHECK_EQ(log.since(kTree, 0)[0].opId, std::string("op-1"));
}

// What the log holds past a head is answered per tree and counted as stored: each tree its own rows, a row the server
// can no longer decode among them, the last seq, and the greatest stamp wherever it sits — here on the first row, a
// phone whose clock ran ahead, with the last row the lowest. A tree level with its log, and one with no row, answer
// nothing.
TEST(pg_op_log_answers_each_trees_own_rows_past_a_head_undecodable_ones_counted_and_the_greatest_stamp_among_them) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  const TreeId other{std::string("pgtest-op-log-other")};
  const auto clearOther = [&] {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("DELETE FROM tree_ops WHERE tree_id = $1", other.str());
    txn.commit();
  };
  clearOther();
  PgOpLog log{pgTestPool()};
  log.append(kTree, opAt(1, "op-1"));
  AppliedOp ahead = opAt(2, "op-2");
  ahead.hlc = Hlc{9'000, 0, "r_phone"};
  AppliedOp servers = opAt(3, "op-3");
  servers.hlc = Hlc{9'000, 1, "srv"};
  AppliedOp honest = opAt(5, "op-5");
  honest.hlc = Hlc{2'000, 0, "r_tablet"};
  for (const AppliedOp& op : {ahead, servers, honest}) log.append(kTree, op);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO tree_ops (tree_id, seq, actor_id, op_id, kind, payload, hlc) "
                    "VALUES ($1, 4, $2, 'op-4', 'NoSuchDeed', '{}'::jsonb, '2500:0:srv')", kTree.str(), kOwner.str());
    txn.commit();
  }
  AppliedOp theirs = opAt(7, "op-7");
  theirs.hlc = Hlc{90'000, 4, "r_tab"};
  log.append(other, theirs);

  CHECK_EQ(log.since(kTree, 1).size(), 3u);
  CHECK(log.past(kTree, 1) == (LogPast{4, 5, Hlc{9'000, 1, "srv"}}));
  CHECK(log.past(kTree, 3) == (LogPast{2, 5, Hlc{2'500, 0, "srv"}}));
  CHECK(log.past(kTree, 5) == LogPast{});
  CHECK(log.past(other, 0) == (LogPast{1, 7, Hlc{90'000, 4, "r_tab"}}));
  CHECK(log.past(TreeId{std::string("pgtest-op-log-none")}, 0) == LogPast{});
  clearOther();
}

// A node has no position, but the log holds the rows an earlier image wrote: a create carrying x and y, a move, and a
// Batch holding a move. The log reads every one — a row it could not decode would be skipped, and a Batch with it —
// the create without its x and y, the move as a command that carries nothing.
TEST(pg_op_log_reads_the_rows_an_earlier_image_wrote_that_set_a_position) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository repo{pgTestPool()};
  repo.create(kTree, LooseGraph().exportState(), LegendState{}, "Op log", kOwner);
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    const std::pair<const char*, const char*> rows[] = {
        {"CreateNode", R"({"id":"a","label":"A","color":"sky","x":3,"y":4})"},
        {"RepositionNode", R"({"id":"a","x":5,"y":6})"},
        {"Batch", R"({"commands":[{"kind":"RepositionNode","payload":{"id":"a","x":7,"y":8}},
                                  {"kind":"RenameNode","payload":{"id":"a","label":"Alpha"}}]})"},
    };
    long long seq = 0;
    for (const auto& [kind, payload] : rows) {
      ++seq;
      txn.exec_params("INSERT INTO tree_ops (tree_id, seq, actor_id, op_id, kind, payload, hlc) "
                      "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)",
                      kTree.str(), seq, kOwner.str(), "op-" + std::to_string(seq), kind, payload,
                      std::to_string(seq) + ":0:srv");
    }
    txn.commit();
  }

  PgOpLog log{pgTestPool()};
  std::vector<std::string> read;
  for (const AppliedOp& op : log.since(kTree, 0))
    read.push_back(std::to_string(op.seq) + " " + commandKind(op.command) + " " + dump(commandPayload(op.command)));
  CHECK_EQ(read, (std::vector<std::string>{
                     R"(1 CreateNode {"color":"sky","icon":"","id":"a","label":"A"})",
                     "2 RepositionNode {}",
                     R"(3 Batch {"commands":[{"kind":"RepositionNode","payload":{}},)"
                     R"({"kind":"RenameNode","payload":{"id":"a","label":"Alpha"}}]})"}));
}

// A persist whose row committed and whose connection then dropped answers normally, keeps the row
// queued, and the next persist lands it once — the lattice was durable before either attempt.
TEST(pg_registry_persist_retries_a_row_that_committed_before_its_connection_dropped_and_lands_it_once) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgTreeRepository repo{pgTestPool()};
  repo.create(kTree, LooseGraph().exportState(), LegendState{}, "Op log", kOwner);
  DroppingPgOpLog log;
  FakeBus bus;
  RoomRegistry registry(repo, log, bus);

  TreeRoom& room = *registry.open(kTree);
  room.applyCommand(createNode("a"), 10, kOwner);
  log.dropNext = true;
  registry.persist(kTree);
  CHECK_EQ(room.pendingOps().size(), 1u);
  CHECK_EQ(rowCount(), 1L);
  CHECK_EQ(repo.load(kTree)->head, static_cast<Seq>(1));

  room.applyCommand(createNode("b"), 11, kOwner);
  registry.persist(kTree);
  CHECK(room.pendingOps().empty());
  CHECK_EQ(rowCount(), 2L);
  REQUIRE_EQ(log.since(kTree, 0).size(), 2u);
  CHECK_EQ(log.since(kTree, 0)[0].seq, static_cast<Seq>(1));
  CHECK_EQ(log.since(kTree, 0)[1].seq, static_cast<Seq>(2));

  registry.evict(kTree);
  CHECK_FALSE(registry.isOpen(kTree));
  TreeRoom& reopened = *registry.open(kTree);
  CHECK_EQ(reopened.head(), static_cast<Seq>(2));
  CHECK(reopened.hasNode(nid("a")));
  CHECK(reopened.hasNode(nid("b")));
  CHECK(reopened.pendingOps().empty());
}
