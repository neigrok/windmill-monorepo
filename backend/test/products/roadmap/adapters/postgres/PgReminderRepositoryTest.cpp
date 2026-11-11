#include "products/roadmap/adapters/postgres/PgReminderRepository.h"

#include "products/roadmap/adapters/postgres/PgProgressRepository.h"
#include "products/roadmap/adapters/postgres/PgTreeRepository.h"
#include "products/roadmap/domain/LooseGraph.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdlib>
#include <string>
#include <vector>

// Readiness against the real tables: opt-in, runs only when WM_PG_TEST is set.
using namespace wm;

// The rows readiness loads carry each node's pointer, so a step behind a node that opens a complete
// tree is ready and the counts are the board's.
TEST(pg_readiness_follows_the_tree_a_node_opens) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset — needs a live Postgres, see RUNNING.md §7");
  const UserId owner{std::string("5a5a0000-0000-4000-8000-00000000a11d")};
  const TreeId main{std::string("t_pgtest_ready_main")};
  const TreeId sub{std::string("t_pgtest_ready_sub")};
  {
    PgLease conn{*pgTestPool()};
    pqxx::work txn{*conn};
    for (const char* table : {"tree_nodes", "tree_edges", "tree_kinds", "node_progress"})
      txn.exec_params(std::string("DELETE FROM ") + table + " WHERE tree_id IN ($1, $2)", main.str(), sub.str());
    txn.exec_params("DELETE FROM trees WHERE owner_id = $1::uuid", owner.str());
    txn.exec_params("INSERT INTO users (id, email) VALUES ($1::uuid, 'pg-readiness@example.test') ON CONFLICT (id) DO NOTHING",
                    owner.str());
    txn.commit();
  }
  PgTreeRepository trees{pgTestPool()};
  PgProgressRepository progress{pgTestPool()};
  PgReminderRepository reminders{pgTestPool()};
  NodeSpec idea;
  idea.id = NodeId{"idea"};
  idea.label = "Idea";
  idea.opens = sub;
  NodeSpec next;
  next.id = NodeId{"next"};
  next.label = "Next";
  next.color = NodeColor::olive;
  next.prerequisites = {NodeId{"idea"}};
  TreeData ideas;
  ideas.id = main;
  ideas.nodes = {idea, next};
  NodeSpec step;
  step.id = NodeId{"s"};
  step.label = "Step";
  step.color = NodeColor::plum;
  TreeData worked;
  worked.id = sub;
  worked.nodes = {step};
  trees.create(main, LooseGraph(ideas, Hlc{1'700'000'000'000, 0, "r_a"}).exportState(), LegendState{}, "Ideas", owner);
  trees.create(sub, LooseGraph(worked, Hlc{1'700'000'000'000, 0, "r_a"}).exportState(), LegendState{}, "Worked", owner);
  const auto summary = [&] {
    std::vector<std::string> lines;
    for (const TreeReadiness& tree : reminders.readinessFor(owner)) {
      std::string line = tree.id.str() + " \"" + tree.title + "\" " + std::to_string(tree.done) + "/" +
                         std::to_string(tree.total) + " ready";
      for (const ReadyStep& ready : tree.ready)
        line += " " + ready.id.str() + ":" + ready.label + ":" + std::string(toString(ready.color));
      lines.push_back(line);
    }
    return lines;
  };

  progress.setStatus(main, owner, NodeId{"idea"}, ProgressStatus::complete, false, Hlc{1'700'000'000'001, 0, "r_a"},
                     1'700'000'000'001);
  CHECK_EQ(summary(), (std::vector<std::string>{"t_pgtest_ready_main \"Ideas\" 0/2 ready idea:Idea:terracotta",
                                                "t_pgtest_ready_sub \"Worked\" 0/1 ready s:Step:plum"}));

  progress.setStatus(sub, owner, NodeId{"s"}, ProgressStatus::complete, false, Hlc{1'700'000'000'002, 0, "r_a"},
                     1'700'000'000'002);
  CHECK_EQ(summary(), (std::vector<std::string>{"t_pgtest_ready_main \"Ideas\" 1/2 ready next:Next:olive",
                                                "t_pgtest_ready_sub \"Worked\" 1/1 ready"}));
}
