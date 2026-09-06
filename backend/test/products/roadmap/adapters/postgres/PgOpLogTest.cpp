#include "products/roadmap/adapters/postgres/PgOpLog.h"

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
};

void reset() {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
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
