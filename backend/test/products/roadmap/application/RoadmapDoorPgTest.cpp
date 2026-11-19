#include "products/roadmap/application/DoorForks.h"

#include "platform/domain/sync/Jcs.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"
#include "test/platform/application/sync/SyncFakes.h"
#include "test/products/roadmap/adapters/mcp/DoorHarness.h"
#include "test/testing.h"

// Roadmap's door over Postgres (Roadmap on the sync engine §7): the same calls the in-memory suite makes
// (DoorToolsTest.cpp), admitted through roadmap's tables on the sync database — a retried requestId writes once, a
// delete clears the caller's completions and a step is read through a deleted one, the fork copies the branch, and a
// call cut short between its tree write and its overlay write makes exactly the rest when sent again.
using namespace wm;
using namespace wm::test;

namespace {

using PgDoor = DoorOver<sync::test::PgWorld>;

Json::Value step(const char* id, const char* label, std::vector<const char*> prerequisites = {}) {
  Json::Value args = node(id, label);
  args["color"] = "terracotta";
  args["prerequisites"] = list(prerequisites);
  return args;
}

}

TEST(the_door_over_postgres_writes_a_retried_call_once_and_reads_a_step_through_a_deleted_one) {
  if (!sync::test::postgresEnabled()) SKIP(sync::test::kNeedsPostgres);
  PgDoor h;
  Json::Value first = step("a", "A");
  first["requestId"] = "req-a";
  const ToolResult made = h.call("create_node", first);
  REQUIRE(!made.isError);
  const Seq head = h.seqOf(h.tree);
  CHECK_EQ(sync::jcs(body(h.call("create_node", first))), sync::jcs(body(made)));
  CHECK_EQ(h.seqOf(h.tree), head);
  REQUIRE(!h.call("create_node", step("b", "B", {"a"})).isError);
  REQUIRE(!h.call("create_node", step("c", "C", {"b"})).isError);
  REQUIRE(!h.call("update_nodes", asUpdate(mark("b", "complete"))).isError);

  const ToolResult deleted = h.call("delete_node", with("nodeId", "b"));
  REQUIRE(!deleted.isError);
  CHECK_EQ(body(deleted)["pruned"]["progress"].asInt(), 1);
  CHECK_EQ(sync::jcs(body(h.call("get_progress", kNoArgs))["completed"]), sync::jcs(Json::Value(Json::arrayValue)));
  Json::Value read(Json::objectValue);
  read["nodeIds"] = list({"c"});
  read["fields"] = list({"id", "prerequisites"});
  CHECK_EQ(sync::jcs(body(h.call("get_nodes", read))["nodes"][0]["prerequisites"]), sync::jcs(list({"a"})));
}

TEST(the_door_over_postgres_forks_a_roadmap_into_the_callers_account) {
  if (!sync::test::postgresEnabled()) SKIP(sync::test::kNeedsPostgres);
  PgDoor h;
  REQUIRE(!h.call("create_node", step("a", "A")).isError);
  REQUIRE(!h.call("create_node", step("b", "B", {"a"})).isError);
  DoorForks forks(h.door, h.tokens);
  const TreeForks::Result forked = forks.fork(TreeId{h.tree}, "", "", h.caller, std::nullopt);
  REQUIRE(forked.outcome == TreeForks::Outcome::forked);
  Json::Value read(Json::objectValue);
  read["treeId"] = forked.data.id.str();
  read["fields"] = list({"id", "prerequisites"});
  const Json::Value copy = body(h.call("get_tree", read))["tree"];
  REQUIRE_EQ(copy["nodes"].size(), 2u);
  CHECK_EQ(sync::jcs(copy["nodes"][1]["prerequisites"]), sync::jcs(list({"a"})));
}

TEST(the_door_over_postgres_makes_exactly_the_rest_of_a_call_cut_short_between_its_writes) {
  if (!sync::test::postgresEnabled()) SKIP(sync::test::kNeedsPostgres);
  PgDoor h;
  const std::string other = h.plant(h.caller, "Other");
  Json::Value args = step("opener", "Opener");
  args["treeId"] = h.tree;
  args["opens"] = other;
  args["requestId"] = "req-opener";
  const Seq before = h.seqOf(h.tree);
  sync::fake::FaultingStore cut(h.world.store(), {{}, {{2, sync::FaultClass::transient}}});
  roadmap::RoadmapDoor brittle(h.world.catalog(), cut, h.world.feed, h.world.clock(), h.clock, h.world.failures);
  RoadmapDoorTools crashing(brittle, h.tokens, h.clock, "https://app.example");
  CHECK_EQ(crashing.callTool("create_node", args, ToolCaller{h.caller, ToolScope::everything()}).outcomeCode, std::string("busy"));
  CHECK_EQ(h.seqOf(h.tree), before + 1);

  h.clock.ms += sync::Limits{}.requestLeaseMs + 1;
  const ToolResult resumed = h.call("create_node", args);
  REQUIRE(!resumed.isError);
  CHECK_EQ(body(resumed)["resumed"].asBool(), true);
  CHECK_EQ(h.seqOf(h.tree), before + 1);
  Json::Value read(Json::objectValue);
  read["nodeIds"] = list({"opener"});
  read["fields"] = list({"id", "opens"});
  CHECK_EQ(body(h.call("get_nodes", read))["nodes"][0]["opens"]["treeId"].asString(), other);
}

TEST(the_door_over_postgres_finishes_a_fork_cut_short_after_its_record_under_its_request_key) {
  if (!sync::test::postgresEnabled()) SKIP(sync::test::kNeedsPostgres);
  PgDoor h;
  REQUIRE(!h.call("create_node", step("a", "A")).isError);
  REQUIRE(!h.call("create_node", step("b", "B", {"a"})).isError);
  const auto listed = [&] { return body(h.call("list_trees", kNoArgs))["trees"].size(); };
  const std::size_t roots = listed();
  sync::fake::FaultingStore cut(h.world.store(), {{}, {{2, sync::FaultClass::transient}}});
  roadmap::RoadmapDoor brittle(h.world.catalog(), cut, h.world.feed, h.world.clock(), h.clock, h.world.failures);
  CHECK(DoorForks(brittle, h.tokens).fork(TreeId{h.tree}, "", "", h.caller, "fork-pg").outcome == TreeForks::Outcome::busy);
  CHECK_EQ(listed(), roots);

  h.clock.ms += sync::Limits{}.requestLeaseMs + 1;
  DoorForks forks(h.door, h.tokens);
  const TreeForks::Result finished = forks.fork(TreeId{h.tree}, "", "", h.caller, "fork-pg");
  REQUIRE(finished.outcome == TreeForks::Outcome::forked);
  Json::Value read(Json::objectValue);
  read["treeId"] = finished.data.id.str();
  CHECK_EQ(body(h.call("get_tree", read))["count"].asUInt64(), 2u);
  CHECK_EQ(listed(), roots + 1);
  CHECK_EQ(forks.fork(TreeId{h.tree}, "", "", h.caller, "fork-pg").data.id, finished.data.id);
  CHECK_EQ(listed(), roots + 1);
}
