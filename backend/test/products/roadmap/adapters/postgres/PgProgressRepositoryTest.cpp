#include "products/roadmap/adapters/postgres/PgProgressRepository.h"

#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <chrono>
#include <cstdlib>
#include <future>
#include <set>
#include <string>
#include <thread>

// The per-user overlay against the real table: opt-in, runs only when WM_PG_TEST is set.
using namespace wm;

namespace {

const char* kNeedsPostgres = "WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7";
const TreeId kTree{std::string("pgtest-progress")};
const UserId kUser{std::string("00000000-0000-4000-8000-0000000000d1")};
constexpr std::uint64_t kNow = 1'700'000'000'000ull;

Hlc at(std::uint64_t ms) { return Hlc{ms, 0, "r_pg"}; }

void reset() {
  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  txn.exec_params("INSERT INTO users(id,email) VALUES($1::uuid,'pg-progress@example.test') ON CONFLICT(id) DO NOTHING", kUser.str());
  txn.exec_params("DELETE FROM node_progress WHERE tree_id = $1", kTree.str());
  txn.commit();
}

}

// The marker's word lands under the status stamp: a stale write cannot take it off, a later mark
// without it does.
TEST(pg_progress_keeps_the_out_of_order_word_under_the_status_stamp) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgressRepository repo{pgTestPool()};
  const NodeId node{std::string("n")};

  CHECK(repo.setStatuses(kTree, kUser, {{node, ProgressStatus::complete, true, at(10)}}, StampedBy::replica, kNow).front().landed.has_value());
  Progress loaded = repo.load(kTree, kUser);
  CHECK_EQ(loaded.completed, (std::set<NodeId>{node}));
  CHECK_EQ(loaded.marks.at(node).at, at(10));
  CHECK_EQ(loaded.marks.at(node).markedAt, kNow);
  CHECK(loaded.marks.at(node).outOfOrder);

  CHECK_FALSE(repo.setStatuses(kTree, kUser, {{node, ProgressStatus::complete, false, at(9)}}, StampedBy::replica, kNow + 1).front().landed.has_value());
  CHECK(repo.load(kTree, kUser).marks.at(node).outOfOrder);

  CHECK(repo.setStatuses(kTree, kUser, {{node, ProgressStatus::complete, false, at(11)}}, StampedBy::replica, kNow + 2).front().landed.has_value());
  loaded = repo.load(kTree, kUser);
  CHECK_EQ(loaded.completed, (std::set<NodeId>{node}));
  CHECK_EQ(loaded.marks.at(node).at, at(11));
  CHECK_FALSE(loaded.marks.at(node).outOfOrder);

  CHECK(repo.setStatuses(kTree, kUser, {{node, ProgressStatus::none, false, at(12)}}, StampedBy::replica, kNow + 3).front().landed.has_value());
  loaded = repo.load(kTree, kUser);
  CHECK_EQ(loaded.cleared, (std::set<NodeId>{node}));
  CHECK_FALSE(loaded.marks.at(node).outOfOrder);
  reset();
}

// A mark repeated under a newer stamp lands like any other: the row takes the stamp and the receipt time, so the
// tree's last-marked time moves. A replica's newer stamp must land for every replica to converge.
TEST(pg_progress_a_repeated_mark_lands_its_newer_stamp_and_moves_the_last_marked_time) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgressRepository repo{pgTestPool()};
  const NodeId node{std::string("n")};

  CHECK(repo.setStatuses(kTree, kUser, {{node, ProgressStatus::complete, false, at(10)}}, StampedBy::replica, kNow).front().landed.has_value());
  CHECK(repo.setStatuses(kTree, kUser, {{node, ProgressStatus::complete, false, at(11)}}, StampedBy::replica, kNow + 5000).front().landed.has_value());
  const Progress loaded = repo.load(kTree, kUser);
  CHECK_EQ(loaded.marks.at(node).at, at(11));
  CHECK_EQ(loaded.marks.at(node).markedAt, kNow + 5000);
  CHECK_EQ(repo.overlaysFor(kUser).at(kTree).lastMarkedAt, kNow + 5000);
  reset();
}

TEST(pg_progress_batch_rolls_back_a_late_storage_failure_and_preserves_outcome_order) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgressRepository repo{pgTestPool()};
  bool failed = false;
  try {
    repo.setStatuses(kTree, kUser, {
        {NodeId{"a"}, ProgressStatus::complete, false, Hlc{20, 0, "good"}},
        {NodeId{"z"}, ProgressStatus::none, false, Hlc{20, 0, std::string(1, '\xff')}}}, StampedBy::replica, kNow);
  } catch (const std::exception&) { failed = true; }
  CHECK(failed);
  CHECK(repo.load(kTree, kUser).marks.empty());
  CHECK(repo.setStatuses(kTree, kUser, {{NodeId{"a"}, ProgressStatus::complete, false, at(50)}}, StampedBy::replica, kNow).front().landed.has_value());
  const std::vector<ProgressWritten> written = repo.setStatuses(kTree, kUser, {
      {NodeId{"z"}, ProgressStatus::none, false, at(60)},
      {NodeId{"a"}, ProgressStatus::none, false, at(40)}}, StampedBy::replica, kNow);
  CHECK((written == std::vector<ProgressWritten>{
                        {ProgressMark{}, ProgressMark{ProgressStatus::none, at(60), kNow, false}},
                        {ProgressMark{ProgressStatus::complete, at(50), 0, false}, std::nullopt}}));
  CHECK_EQ(repo.load(kTree, kUser).completed, (std::set<NodeId>{NodeId{"a"}}));
  CHECK_EQ(repo.load(kTree, kUser).cleared, (std::set<NodeId>{NodeId{"z"}}));
  reset();
}

// One statement answers the mark a write met and the mark the row took. A replica's mark lands when its stamp is the
// later and loses otherwise; a server's lands either way, at its own stamp or just after the one it found, the next
// millisecond once the counter is spent; and a node named twice meets its own earlier row.
TEST(pg_a_progress_write_answers_the_mark_it_met_and_the_mark_the_row_took) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgressRepository repo{pgTestPool()};
  const NodeId node{"a"};
  const auto one = [&](ProgressStatus status, bool word, const Hlc& stamp, StampedBy stampedBy) {
    return repo.setStatuses(kTree, kUser, {{node, status, word, stamp}}, stampedBy, kNow).front();
  };

  CHECK((one(ProgressStatus::complete, true, at(10), StampedBy::replica) ==
         ProgressWritten{ProgressMark{}, ProgressMark{ProgressStatus::complete, at(10), kNow, true}}));
  CHECK((one(ProgressStatus::complete, false, at(20), StampedBy::replica) ==
         ProgressWritten{ProgressMark{ProgressStatus::complete, at(10), 0, true},
                         ProgressMark{ProgressStatus::complete, at(20), kNow, false}}));
  CHECK((one(ProgressStatus::none, false, at(15), StampedBy::replica) ==
         ProgressWritten{ProgressMark{ProgressStatus::complete, at(20), 0, false}, std::nullopt}));
  CHECK((one(ProgressStatus::none, false, Hlc{5, 0, "srv"}, StampedBy::server) ==
         ProgressWritten{ProgressMark{ProgressStatus::complete, at(20), 0, false},
                         ProgressMark{ProgressStatus::none, Hlc{20, 1, "srv"}, kNow, false}}));
  CHECK((one(ProgressStatus::complete, false, Hlc{30, 4, "srv"}, StampedBy::server) ==
         ProgressWritten{ProgressMark{ProgressStatus::none, Hlc{20, 1, "srv"}, 0, false},
                         ProgressMark{ProgressStatus::complete, Hlc{30, 4, "srv"}, kNow, false}}));
  CHECK(repo.load(kTree, kUser).marks.at(node).at == (Hlc{30, 4, "srv"}));

  CHECK((repo.setStatuses(kTree, kUser,
                          {{node, ProgressStatus::none, false, Hlc{7, 0, "srv"}},
                           {node, ProgressStatus::complete, false, Hlc{7, 0, "srv"}}},
                          StampedBy::server, kNow) ==
         std::vector<ProgressWritten>{
             {ProgressMark{ProgressStatus::complete, Hlc{30, 4, "srv"}, 0, false},
              ProgressMark{ProgressStatus::none, Hlc{30, 5, "srv"}, kNow, false}},
             {ProgressMark{ProgressStatus::none, Hlc{30, 5, "srv"}, 0, false},
              ProgressMark{ProgressStatus::complete, Hlc{30, 6, "srv"}, kNow, false}}}));

  CHECK(repo.setStatuses(kTree, kUser, {{node, ProgressStatus::complete, false, Hlc{40, 4294967295u, "phone"}}}, StampedBy::replica, kNow).front().landed.has_value());
  CHECK((one(ProgressStatus::none, false, Hlc{7, 0, "srv"}, StampedBy::server) ==
         ProgressWritten{ProgressMark{ProgressStatus::complete, Hlc{40, 4294967295u, "phone"}, 0, false},
                         ProgressMark{ProgressStatus::none, Hlc{41, 0, "srv"}, kNow, false}}));
  CHECK(repo.load(kTree, kUser).marks.at(node).at == (Hlc{41, 0, "srv"}));
  reset();
}

// A write that reaches a row another door is writing waits for it and answers the row that door left, so what it says
// it met is what it wrote over: a server's `complete` over a replica's clear stamped ahead lands after it. Where the
// other door's write is the row's first, the statement cannot see what it held: the mark still lands after it, and the
// write says it does not know what it met.
TEST(pg_a_progress_write_waits_for_a_write_under_way_and_answers_the_row_it_left) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  reset();
  PgProgressRepository repo{pgTestPool()};
  REQUIRE(repo.setStatuses(kTree, kUser, {{NodeId{"a"}, ProgressStatus::complete, false, at(10)}}, StampedBy::replica, kNow).front().landed.has_value());
  const auto behind = [&](const char* otherDoorsWrite, const NodeId& node, ProgressStatus status) {
    PgLease lease{*pgTestPool()};
    pqxx::work other{*lease};
    other.exec_params(otherDoorsWrite, kTree.str(), kUser.str());
    auto write = std::async(std::launch::async, [&] {
      return repo.setStatuses(kTree, kUser, {{node, status, false, Hlc{50, 0, "srv"}}}, StampedBy::server, kNow).front();
    });
    int waiting = 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
      waiting = other.exec("select count(*) from pg_locks where not granted and pid <> pg_backend_pid()")[0][0].as<int>();
      if (waiting == 1) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    CHECK_EQ(waiting, 1);
    CHECK_EQ(write.wait_for(std::chrono::milliseconds(50)), std::future_status::timeout);
    other.commit();
    return write.get();
  };

  CHECK((behind("UPDATE node_progress SET status = 'none', hlc = '100:0:phone', stamp_ms = 100, stamp_counter = 0 "
                "WHERE tree_id = $1 AND user_id = $2 AND node_id = 'a'",
                NodeId{"a"}, ProgressStatus::complete) ==
         ProgressWritten{ProgressMark{ProgressStatus::none, Hlc{100, 0, "phone"}, 0, false},
                         ProgressMark{ProgressStatus::complete, Hlc{100, 1, "srv"}, kNow, false}}));
  CHECK((behind("INSERT INTO node_progress (tree_id, user_id, node_id, status, hlc, stamp_ms, stamp_counter) "
                "VALUES ($1, $2, 'b', 'complete', '100:0:phone', 100, 0)",
                NodeId{"b"}, ProgressStatus::none) ==
         ProgressWritten{std::nullopt, ProgressMark{ProgressStatus::none, Hlc{100, 1, "srv"}, kNow, false}}));
  CHECK_EQ(repo.load(kTree, kUser).completed, (std::set<NodeId>{NodeId{"a"}}));
  CHECK_EQ(repo.load(kTree, kUser).cleared, (std::set<NodeId>{NodeId{"b"}}));
  reset();
}

TEST(pg_legacy_progress_reads_as_cleared_and_preserves_completion_and_stamps) {
  if (!std::getenv("WM_PG_TEST")) SKIP(kNeedsPostgres);
  const TreeId tree{"pgtest-progress-legacy"};
  const UserId user{"00000000-0000-4000-8000-0000000000d2"};
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    txn.exec_params("INSERT INTO users(id,email) VALUES($1::uuid,'pg-progress-legacy@example.test') ON CONFLICT(id) DO NOTHING", user.str());
    txn.exec_params("DELETE FROM node_progress WHERE tree_id = $1", tree.str());
    txn.exec_params(
        "INSERT INTO node_progress (tree_id,user_id,node_id,status,out_of_order,hlc,stamp_ms,updated_at) VALUES "
        "($1,$2,'a','active',true,'100:0:r_old',100,to_timestamp(1000)),"
        "($1,$2,'b','inProgress',true,'101:0:r_old',101,to_timestamp(1001)),"
        "($1,$2,'c','complete',true,'102:0:r_old',102,to_timestamp(1002))",
        tree.str(), user.str());
    txn.commit();
  }
  PgProgressRepository repo{pgTestPool()};
  const Progress progress = repo.load(tree, user);
  CHECK_EQ(progress.completed, (std::set<NodeId>{NodeId{"c"}}));
  CHECK_EQ(progress.cleared, (std::set<NodeId>{NodeId{"a"}, NodeId{"b"}}));
  CHECK_EQ(progress.marks.at(NodeId{"a"}).at, (Hlc{100, 0, "r_old"}));
  CHECK_EQ(progress.marks.at(NodeId{"a"}).markedAt, 1000000u);
  CHECK_FALSE(progress.marks.at(NodeId{"a"}).outOfOrder);
  CHECK_FALSE(progress.marks.at(NodeId{"b"}).outOfOrder);
  CHECK(progress.marks.at(NodeId{"c"}).outOfOrder);
  CHECK_EQ(repo.overlaysFor(user).at(tree).overlay.completed, (std::set<NodeId>{NodeId{"c"}}));

  CHECK_FALSE(repo.setStatuses(tree, user, {{NodeId{"a"}, ProgressStatus::complete, false, at(99)}}, StampedBy::replica, 1003).front().landed.has_value());
  CHECK(repo.setStatuses(tree, user, {{NodeId{"a"}, ProgressStatus::complete, false, at(103)}}, StampedBy::replica, 1003).front().landed.has_value());
  CHECK_EQ(repo.load(tree, user).completed, (std::set<NodeId>{NodeId{"a"}, NodeId{"c"}}));

  PgLease conn{*pgTestPool()};
  pqxx::work txn{*conn};
  txn.exec_params("DELETE FROM node_progress WHERE tree_id = $1", tree.str());
  txn.commit();
}
