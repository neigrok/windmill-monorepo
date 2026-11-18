#include "test/products/roadmap/adapters/mcp/DoorHarness.h"

#include "products/roadmap/adapters/auth/ForkSignup.h"
#include "products/roadmap/application/DoorForks.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"
#include "test/platform/application/sync/SyncFakes.h"
#include "test/testing.h"

#include <set>
#include <string>

// Roadmap's tools through the engine's door (Roadmap on the sync engine §7): a retried call writes once, MCP's meanings
// of delete_node, change_edges, import_subgraph and expectedSeq hold, reads follow through absent steps (D-5), and the
// fork copies a branch as §7 says. The session the wire corpus pins runs beside these (WireCorpusTest.cpp).
using namespace wm;
using namespace wm::test;

namespace {

Json::Value edge(const char* from, const char* to) {
  Json::Value value(Json::objectValue);
  value["from"] = from;
  value["to"] = to;
  return value;
}

Json::Value added(std::vector<Json::Value> edges) {
  Json::Value args(Json::objectValue);
  args["add"] = Json::Value(Json::arrayValue);
  for (Json::Value& one : edges) args["add"].append(one);
  return args;
}

Json::Value step(const char* id, const char* label, std::vector<const char*> prerequisites = {}) {
  Json::Value args = node(id, label);
  args["color"] = "terracotta";
  args["prerequisites"] = list(prerequisites);
  return args;
}

// A chain a → b → c of terracotta steps on the harness's roadmap.
void chain(DoorHarness& h) {
  REQUIRE(!h.call("create_node", step("a", "A")).isError);
  REQUIRE(!h.call("create_node", step("b", "B", {"a"})).isError);
  REQUIRE(!h.call("create_node", step("c", "C", {"b"})).isError);
}

Json::Value fields(std::vector<const char*> names) { return list(names); }

// The owner makes their roadmap public, as a device writes its visibility.
void publish(DoorHarness& h, const std::string& tree) {
  h.door.run(h.caller, std::nullopt, "test.publish", Json::Value(), [&](roadmap::RoadmapDoor::Call& call) {
    Json::Value fields(Json::objectValue);
    fields["visibility"] = "public";
    Json::Value deltas(Json::arrayValue);
    deltas.append(roadmap::Written{.type = "meta", .id = Json::Value("meta"), .fields = fields}.json());
    return call.admit(roadmap::intentIn("tree/" + tree, deltas));
  });
}

}

TEST(door_a_retried_write_under_its_request_id_writes_once_and_answers_as_the_first) {
  DoorHarness h;
  Json::Value args = step("a", "A");
  args["requestId"] = "req-create-a";
  const ToolResult first = h.call("create_node", args);
  REQUIRE(!first.isError);
  const Seq after = h.seqOf(h.tree);
  const ToolResult again = h.call("create_node", args);
  CHECK_EQ(sync::jcs(body(again)), sync::jcs(body(first)));
  CHECK_EQ(h.seqOf(h.tree), after);

  Json::Value other = step("b", "B");
  other["requestId"] = "req-create-a";
  const ToolResult conflict = h.call("create_node", other);
  CHECK(conflict.isError);
  CHECK_EQ(conflict.outcomeCode, std::string("request-conflict"));
  CHECK_EQ(h.seqOf(h.tree), after);
}

TEST(door_a_request_id_that_names_a_part_is_refused_before_anything_is_written) {
  DoorHarness h;
  Json::Value args = step("a", "A");
  args["requestId"] = "req#1";
  const Seq before = h.seqOf(h.tree);
  const ToolResult refused = h.call("create_node", args);
  CHECK(refused.isError);
  CHECK_EQ(message(refused), std::string("create_node: requestId must not contain \"#\" — send any other id of your choosing"));
  CHECK_EQ(h.seqOf(h.tree), before);
}

TEST(door_declares_a_request_id_on_every_write_and_on_no_read) {
  DoorHarness h;
  for (const ToolDeclaration& tool : h.tools.declareTools()) {
    const bool takes = tool.descriptor["inputSchema"]["properties"].isMember("requestId");
    CHECK_EQ(takes, tool.access != Access::read);
  }
}

TEST(door_expected_seq_is_the_tree_scopes_sequence_number) {
  DoorHarness h;
  chain(h);
  const Seq head = h.seqOf(h.tree);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["seq"].asUInt64(), head);

  Json::Value stale = added({edge("a", "c")});
  stale["expectedSeq"] = static_cast<Json::Int64>(head - 1);
  const ToolResult refused = h.call("change_edges", stale);
  CHECK(refused.isError);
  CHECK_EQ(message(refused), "change_edges: expectedSeq conflict: requested " + std::to_string(head - 1) +
                                 ", current seq is " + std::to_string(head) +
                                 ". Nothing changed; read get_nodes or get_tree and retry with the current seq.");
  CHECK_EQ(h.seqOf(h.tree), head);

  Json::Value current = added({edge("a", "c")});
  current["expectedSeq"] = static_cast<Json::Int64>(head);
  const ToolResult landed = h.call("change_edges", current);
  REQUIRE(!landed.isError);
  CHECK_EQ(body(landed)["seq"].asUInt64(), head + 1);
  CHECK_EQ(h.seqOf(h.tree), head + 1);
}

TEST(door_change_edges_lands_a_loop_and_names_it) {
  DoorHarness h;
  chain(h);
  const ToolResult closed = h.call("change_edges", added({edge("c", "a")}));
  REQUIRE(!closed.isError);
  const Json::Value receipt = body(closed);
  CHECK_EQ(receipt["applied"].asBool(), true);
  CHECK_EQ(receipt["diagnosticsClean"].asBool(), false);
  REQUIRE_EQ(receipt["introducedDiagnostics"].size(), 1u);
  CHECK_EQ(receipt["introducedDiagnostics"][0].asString(), std::string("cycle among \"a\", \"b\", \"c\""));
  const Json::Value diagnostics = body(h.call("get_diagnostics", kNoArgs));
  REQUIRE_EQ(diagnostics["cycles"].size(), 1u);
  CHECK_EQ(sync::jcs(diagnostics["cycles"][0]["nodes"]), sync::jcs(list({"a", "b", "c"})));
}

TEST(door_import_subgraph_lands_a_loop_and_names_it) {
  DoorHarness h;
  chain(h);
  Json::Value args(Json::objectValue);
  args["nodes"] = Json::Value(Json::arrayValue);
  Json::Value looped = node("a", "A");
  looped["prerequisites"] = list({"c"});
  args["nodes"].append(looped);
  const ToolResult grafted = h.call("import_subgraph", args);
  REQUIRE(!grafted.isError);
  const Json::Value receipt = body(grafted);
  CHECK_EQ(receipt["imported"].asBool(), true);
  CHECK_EQ(receipt["diagnosticsClean"].asBool(), false);
  REQUIRE_EQ(receipt["introducedDiagnostics"].size(), 1u);
  CHECK_EQ(receipt["introducedDiagnostics"][0].asString(), std::string("cycle among \"a\", \"b\", \"c\""));
}

TEST(door_delete_node_clears_the_callers_marks_and_prunes_the_links_it_names) {
  DoorHarness h;
  chain(h);
  REQUIRE(!h.call("update_nodes", asUpdate(mark("b", "complete"))).isError);
  Json::Value args(Json::objectValue);
  args["nodeId"] = "b";
  args["prune"] = true;
  const ToolResult deleted = h.call("delete_node", args);
  REQUIRE(!deleted.isError);
  const Json::Value receipt = body(deleted);
  CHECK_EQ(receipt["id"].asString(), std::string("b"));
  CHECK_EQ(receipt["pruned"]["edges"].asInt(), 2);
  CHECK_EQ(receipt["pruned"]["progress"].asInt(), 1);
  CHECK_EQ(sync::jcs(body(h.call("get_progress", kNoArgs))["completed"]), sync::jcs(Json::Value(Json::arrayValue)));

  Json::Value revive = step("b", "B");
  REQUIRE(!h.call("create_node", revive).isError);
  CHECK_EQ(sync::jcs(body(h.call("get_progress", kNoArgs))["completed"]), sync::jcs(Json::Value(Json::arrayValue)));
}

TEST(door_a_step_follows_through_a_deleted_step_without_a_prune) {
  DoorHarness h;
  chain(h);
  Json::Value args(Json::objectValue);
  args["nodeId"] = "b";
  const ToolResult deleted = h.call("delete_node", args);
  REQUIRE(!deleted.isError);
  CHECK_EQ(body(deleted)["diagnosticsClean"].asBool(), true);
  CHECK_EQ(sync::jcs(body(deleted)["introducedDiagnostics"]), sync::jcs(Json::Value(Json::arrayValue)));
  CHECK_EQ(sync::jcs(body(h.call("get_diagnostics", kNoArgs))["dangling"]), sync::jcs(Json::Value(Json::arrayValue)));
  Json::Value read(Json::objectValue);
  read["nodeIds"] = list({"c"});
  read["fields"] = fields({"id", "prerequisites", "state"});
  const Json::Value nodes = body(h.call("get_nodes", read))["nodes"];
  REQUIRE_EQ(nodes.size(), 1u);
  CHECK_EQ(sync::jcs(nodes[0]["prerequisites"]), sync::jcs(list({"a"})));
  CHECK_EQ(nodes[0]["state"].asString(), std::string("locked"));
}

TEST(door_delete_node_refuses_a_step_that_owns_a_subtree_its_branches_do_not_name) {
  DoorHarness h;
  chain(h);
  const Json::Value made = body(h.call("create_subtree", with("nodeId", "b")));
  const std::string subtree = made["subtree"]["id"].asString();
  const Seq before = h.seqOf(h.tree);

  const ToolResult refused = h.call("delete_node", with("nodeId", "b"));
  CHECK(refused.isError);
  CHECK_EQ(refused.outcomeCode, std::string("branch-unconfirmed"));
  CHECK_EQ(message(refused), "delete_node: step \"b\" owns the subtree \"" + subtree +
                                 "\", holding 0 steps. Deleting a step that owns a subtree hides that subtree and "
                                 "everything under it until the step is revived; pass branches: [\"" + subtree +
                                 "\"] to take them with their steps. Nothing was deleted.");
  CHECK_EQ(h.seqOf(h.tree), before);

  Json::Value confirmed = with("nodeId", "b");
  confirmed["branches"] = list({subtree.c_str()});
  REQUIRE(!h.call("delete_node", confirmed).isError);
  Json::Value inside(Json::objectValue);
  inside["treeId"] = subtree;
  const ToolResult hidden = h.call("get_tree", inside);
  CHECK(hidden.isError);
  CHECK_EQ(message(hidden), "get_tree: no such tree \"" + subtree + "\"");
}

TEST(door_another_persons_roadmap_is_absent_to_its_writes) {
  DoorHarness h;
  chain(h);
  const Seq before = h.seqOf(h.tree);
  const ToolResult refused = h.as(h.reader, "create_node", step("x", "X"));
  CHECK(refused.isError);
  CHECK_EQ(message(refused), "create_node: no such tree \"" + h.tree + "\"");
  CHECK_EQ(h.seqOf(h.tree), before);
}

TEST(door_delete_tree_takes_the_steps_of_the_owners_other_roadmaps_that_open_it) {
  DoorHarness h;
  const std::string other = h.plant(h.caller, "Other");
  Json::Value opener = step("to-other", "Other");
  opener["opens"] = other;
  REQUIRE(!h.call("create_node", opener).isError);
  Json::Value args(Json::objectValue);
  args["treeId"] = other;
  const ToolResult removed = h.call("delete_tree", args);
  REQUIRE(!removed.isError);
  const Json::Value receipt = body(removed);
  CHECK_EQ(receipt["deleted"].asBool(), true);
  REQUIRE_EQ(receipt["removed"].size(), 1u);
  CHECK_EQ(receipt["removed"][0]["treeId"].asString(), h.tree);
  CHECK_EQ(sync::jcs(receipt["removed"][0]["nodeIds"]), sync::jcs(list({"to-other"})));
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["count"].asUInt64(), 0u);
}

TEST(door_fork_copies_a_branch_under_new_ids_clears_status_and_keeps_only_the_owners_pointers) {
  DoorHarness h;
  chain(h);
  REQUIRE(!h.call("update_tree", with("guide", "Work it top down.")).isError);
  Json::Value seeded(Json::objectValue);
  seeded["nodes"] = Json::Value(Json::arrayValue);
  Json::Value done = node("a", "A");
  done["seedStatus"] = "complete";
  seeded["nodes"].append(done);
  REQUIRE(!h.call("import_subgraph", seeded).isError);
  const std::string subtree = body(h.call("create_subtree", with("nodeId", "c")))["subtree"]["id"].asString();
  Json::Value inside = step("deep", "Deep");
  inside["treeId"] = subtree;
  REQUIRE(!h.call("create_node", inside).isError);
  const std::string other = h.plant(h.caller, "Other");
  REQUIRE(!h.call("update_nodes", [&] {
    Json::Value row = with("nodeId", "a");
    row["opens"] = other;
    return asUpdate(row);
  }()).isError);

  DoorForks forks(h.door, h.tokens);
  const TreeForks::Result mine = forks.fork(TreeId{h.tree}, "", "", h.caller);
  REQUIRE(mine.outcome == TreeForks::Outcome::forked);
  CHECK(mine.data.id.str() != h.tree);
  Json::Value copied(Json::objectValue);
  copied["treeId"] = mine.data.id.str();
  copied["fields"] = fields({"id", "seedStatus", "opens", "subtree"});
  const Json::Value copy = body(h.call("get_tree", copied))["tree"];
  CHECK_EQ(copy["guide"]["yours"].asBool(), true);
  REQUIRE_EQ(copy["nodes"].size(), 3u);
  CHECK(!copy["nodes"][0].isMember("seedStatus"));
  CHECK_EQ(copy["nodes"][0]["opens"]["treeId"].asString(), other);
  const std::string subtreeCopy = copy["nodes"][2]["subtree"]["id"].asString();
  CHECK(!subtreeCopy.empty() && subtreeCopy != subtree);
  Json::Value deep(Json::objectValue);
  deep["treeId"] = subtreeCopy;
  const Json::Value below = body(h.call("get_tree", deep))["tree"];
  CHECK_EQ(below["parent"]["tree"].asString(), mine.data.id.str());
  REQUIRE_EQ(below["nodes"].size(), 1u);
  CHECK_EQ(below["nodes"][0]["id"].asString(), std::string("deep"));

  CHECK(forks.fork(TreeId{h.tree}, "", "", h.reader).outcome == TreeForks::Outcome::noSource);
  publish(h, h.tree);
  const TreeForks::Result theirs = forks.fork(TreeId{h.tree}, "", "", h.reader);
  REQUIRE(theirs.outcome == TreeForks::Outcome::forked);
  Json::Value read(Json::objectValue);
  read["treeId"] = theirs.data.id.str();
  read["fields"] = fields({"id", "opens"});
  const Json::Value forked = body(h.as(h.reader, "get_tree", read))["tree"];
  CHECK_EQ(forked["guide"]["text"].asString(), std::string("Work it top down."));
  CHECK_EQ(forked["guide"]["yours"].asBool(), false);
  REQUIRE_EQ(forked["nodes"].size(), 3u);
  CHECK(!forked["nodes"][0].isMember("opens"));
  const TreeForks::Result alone = forks.fork(TreeId{subtree}, "", "", h.caller);
  REQUIRE(alone.outcome == TreeForks::Outcome::notARoot);
  CHECK_EQ(alone.notARoot->owningStep.step.str(), std::string("c"));
}

namespace {

// The door's tools over the same engine as `h`, on a store that fails the call's `k`-th stored admit as a lost
// connection would: what the call admitted before it stays, and the call stays running under its requestId.
struct CutShort {
  sync::fake::FaultingStore store;
  roadmap::RoadmapDoor door;
  RoadmapDoorTools tools;

  CutShort(DoorHarness& h, int k)
      : store(h.world.store(), {{}, {{k, sync::FaultClass::transient}}}),
        door(h.world.catalog(), store, h.world.feed, h.world.clock(), h.clock, h.world.failures),
        tools(door, h.tokens, h.clock, "https://app.example") {}
};

Json::Value opensOf(DoorHarness& h, const char* step) {
  Json::Value read(Json::objectValue);
  read["nodeIds"] = list({step});
  read["fields"] = list({"id", "opens"});
  return body(h.call("get_nodes", read))["nodes"][0]["opens"];
}

std::size_t marksIn(DoorHarness& h, const UserId& who) {
  return h.door.read([&](sync::SyncTxn& txn) { return h.door.rows().tree(txn, h.tree, who).marks.size(); });
}

}

TEST(door_a_call_cut_short_between_its_tree_and_overlay_writes_makes_exactly_the_rest_when_sent_again) {
  DoorHarness h;
  const std::string other = h.plant(h.caller, "Other");
  Json::Value args = step("opener", "Opener");
  args["treeId"] = h.tree;
  args["opens"] = other;
  args["requestId"] = "req-opener";
  const Seq before = h.seqOf(h.tree);

  CutShort cut(h, 2);
  const ToolResult first = cut.tools.callTool("create_node", args, ToolCaller{h.caller, ToolScope::everything()});
  CHECK(first.isError);
  CHECK_EQ(first.outcomeCode, std::string("busy"));
  CHECK_EQ(h.seqOf(h.tree), before + 1);
  CHECK(opensOf(h, "opener").isNull());

  const ToolResult running = h.call("create_node", args);
  CHECK_EQ(running.outcomeCode, std::string("busy"));
  CHECK(opensOf(h, "opener").isNull());

  h.clock.ms += sync::Limits{}.requestLeaseMs + 1;
  const ToolResult resumed = h.call("create_node", args);
  REQUIRE(!resumed.isError);
  CHECK_EQ(body(resumed)["resumed"].asBool(), true);
  CHECK_EQ(body(resumed)["seq"].asUInt64(), before + 1);
  CHECK_EQ(h.seqOf(h.tree), before + 1);
  CHECK_EQ(opensOf(h, "opener")["treeId"].asString(), other);

  const ToolResult answered = h.call("create_node", args);
  CHECK_EQ(sync::jcs(body(answered)), sync::jcs(body(resumed)));
  CHECK_EQ(h.seqOf(h.tree), before + 1);
}

TEST(door_a_delete_cut_short_after_its_marks_cleared_deletes_the_steps_when_sent_again) {
  DoorHarness h;
  chain(h);
  REQUIRE(!h.call("update_nodes", asUpdate(mark("b", "complete"))).isError);
  Json::Value args = with("nodeId", "b");
  args["treeId"] = h.tree;
  args["requestId"] = "req-delete-b";
  const Seq before = h.seqOf(h.tree);

  CutShort cut(h, 2);
  CHECK_EQ(cut.tools.callTool("delete_node", args, ToolCaller{h.caller, ToolScope::everything()}).outcomeCode, std::string("busy"));
  CHECK_EQ(sync::jcs(body(h.call("get_progress", kNoArgs))["completed"]), sync::jcs(Json::Value(Json::arrayValue)));
  CHECK_EQ(h.seqOf(h.tree), before);

  h.clock.ms += sync::Limits{}.requestLeaseMs + 1;
  const ToolResult resumed = h.call("delete_node", args);
  REQUIRE(!resumed.isError);
  CHECK_EQ(body(resumed)["resumed"].asBool(), true);
  CHECK_EQ(h.seqOf(h.tree), before + 1);
  CHECK_EQ(body(h.call("get_tree", kNoArgs))["count"].asUInt64(), 2u);
}

TEST(door_a_call_the_engine_cannot_take_now_answers_busy_and_writes_nothing) {
  DoorHarness h;
  const Seq before = h.seqOf(h.tree);
  CutShort cut(h, 1);
  Json::Value args = step("a", "A");
  args["treeId"] = h.tree;
  args["requestId"] = "req-busy";
  const ToolResult busy = cut.tools.callTool("create_node", args, ToolCaller{h.caller, ToolScope::everything()});
  CHECK(busy.isError);
  CHECK_EQ(busy.outcomeCode, std::string("busy"));
  CHECK_EQ(message(busy), std::string("create_node: the roadmap is busy just now and nothing was written. Send the same call "
                                      "again in a moment."));
  CHECK_EQ(h.seqOf(h.tree), before);
  REQUIRE(!h.call("create_node", args).isError);
  CHECK_EQ(h.seqOf(h.tree), before + 1);
}

TEST(door_a_readers_marks_on_a_public_roadmap_land_in_their_own_overlay_alone) {
  DoorHarness h;
  chain(h);
  CHECK(h.as(h.reader, "update_nodes", asUpdate(mark("a", "complete"))).isError);
  publish(h, h.tree);
  const ToolResult marked = h.as(h.reader, "update_nodes", asUpdate(mark("a", "complete")));
  REQUIRE(!marked.isError);
  CHECK_EQ(body(marked)["progress"][0]["status"].asString(), std::string("complete"));
  CHECK_EQ(sync::jcs(body(h.as(h.reader, "get_progress", kNoArgs))["completed"]), sync::jcs(list({"a"})));
  CHECK_EQ(sync::jcs(body(h.call("get_progress", kNoArgs))["completed"]), sync::jcs(Json::Value(Json::arrayValue)));
  CHECK_EQ(marksIn(h, h.reader), 1u);
  CHECK_EQ(marksIn(h, h.caller), 0u);
  CHECK(h.as(h.reader, "create_node", step("x", "X")).isError);
}

TEST(door_the_fork_at_sign_up_plants_a_readable_roadmap_in_the_new_account) {
  DoorHarness h;
  chain(h);
  DoorForks forks(h.door, h.tokens);
  ForkSignup signup(forks);
  CHECK(!signup.describe(h.tree).has_value());
  CHECK(!signup.plant(h.tree, h.reader).has_value());
  publish(h, h.tree);
  const std::optional<ForkDescription> described = signup.describe(h.tree);
  REQUIRE(described.has_value());
  CHECK_EQ(described->title, std::string("Test Roadmap"));
  CHECK_EQ(described->meta, std::string("3 steps"));
  const std::optional<std::string> planted = signup.plant(h.tree, h.reader);
  REQUIRE(planted.has_value());
  CHECK(*planted != h.tree);
  Json::Value read(Json::objectValue);
  read["treeId"] = *planted;
  const Json::Value copy = body(h.as(h.reader, "get_tree", read));
  CHECK_EQ(copy["count"].asUInt64(), 3u);
  CHECK_EQ(copy["tree"]["title"].asString(), std::string("Test Roadmap"));
  CHECK(h.call("get_tree", read).isError);
}
