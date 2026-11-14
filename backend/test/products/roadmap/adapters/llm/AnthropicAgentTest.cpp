#include "products/roadmap/adapters/llm/AnthropicAgent.h"

#include "products/roadmap/application/ScopedToolHost.h"
#include "platform/application/WriteObservation.h"
#include "test/products/roadmap/adapters/mcp/ToolsHarness.h"
#include "test/testing.h"

#include <optional>
#include <string>
#include <vector>

using namespace wm;

namespace {

struct FakeToolHost : ToolHost {
  std::vector<ToolDeclaration> catalog;
  std::vector<std::pair<std::string, Json::Value>> calls;
  std::function<ToolResult(const std::string&, const Json::Value&)> responder;

  std::vector<ToolDeclaration> declareTools() const override { return catalog; }

  ToolResult callTool(const std::string& name, const Json::Value& arguments, const ToolCaller&) override {
    calls.push_back({name, arguments});
    if (responder) return responder(name, arguments);
    return ToolResult::text("ok");
  }
};

// Hands out `replies` one per iteration, then falls back to `whenExhausted` (a repeating reply) or nullopt (an upstream failure).
struct FakeModel {
  std::vector<Json::Value> replies;
  std::optional<Json::Value> whenExhausted;
  std::vector<Json::Value> requests;
  std::size_t index = 0;

  MessagesCall asCall() {
    return [this](const Json::Value& request) -> std::optional<Json::Value> {
      requests.push_back(request);
      if (index < replies.size()) return replies[index++];
      return whenExhausted;
    };
  }
};

Json::Value mcpTool(const char* name, const char* description) {
  Json::Value schema(Json::objectValue);
  schema["type"] = "object";
  Json::Value properties(Json::objectValue);
  Json::Value treeId(Json::objectValue);
  treeId["type"] = "string";
  properties["treeId"] = treeId;
  schema["properties"] = properties;
  schema["additionalProperties"] = false;

  Json::Value tool(Json::objectValue);
  tool["name"] = name;
  tool["description"] = description;
  tool["inputSchema"] = schema;
  return tool;
}

Json::Value toolUseReply(const char* name, const char* id) {
  Json::Value block(Json::objectValue);
  block["type"] = "tool_use";
  block["id"] = id;
  block["name"] = name;
  block["input"] = Json::Value(Json::objectValue);
  Json::Value content(Json::arrayValue);
  content.append(block);
  Json::Value reply(Json::objectValue);
  reply["stop_reason"] = "tool_use";
  reply["content"] = content;
  return reply;
}

Json::Value textReply(const char* stopReason, const char* text) {
  Json::Value block(Json::objectValue);
  block["type"] = "text";
  block["text"] = text;
  Json::Value content(Json::arrayValue);
  content.append(block);
  Json::Value reply(Json::objectValue);
  reply["stop_reason"] = stopReason;
  reply["content"] = content;
  return reply;
}

struct Recorder {
  std::vector<AgentStep> steps;
  std::vector<std::string> failures;  // "where | detail", exactly what the operator would see

  std::function<void(const AgentStep&)> onStep() {
    return [this](const AgentStep& step) { steps.push_back(step); };
  }
  AgentReporter report() {
    return [this](const std::string& where, const std::string& detail) {
      failures.push_back(where + " | " + detail);
    };
  }
};

const TreeId kTree{"t_0123456789abcdef"};
const UserId kCaller{"agent"};

ToolDeclaration declared(const char* name, const char* description) {
  return ToolDeclaration{mcpTool(name, description), "roadmap", Access::write};
}

Json::Value catalogSeenBy(const FakeToolHost& host) {
  return host.listTools(ToolCaller{kCaller, ToolScope::everything()});
}

}

// --- Tool-schema translation ---------------------------------------------------------------

TEST(agent_tools_rename_inputSchema_to_input_schema_and_keep_the_rest) {
  Json::Value catalog(Json::arrayValue);
  catalog.append(mcpTool("get_tree", "Read a roadmap."));
  catalog.append(mcpTool("create_node", "Add a step."));

  const Json::Value translated = agentTools(catalog);

  REQUIRE_EQ(translated.size(), 2u);
  CHECK_EQ(translated[0]["name"].asString(), std::string("get_tree"));
  CHECK_EQ(translated[0]["description"].asString(), std::string("Read a roadmap."));
  CHECK_EQ(translated[0]["input_schema"], catalog[0]["inputSchema"]);
  CHECK_FALSE(translated[0].isMember("inputSchema"));
  CHECK_EQ(translated[1]["name"].asString(), std::string("create_node"));
  CHECK_EQ(translated[1]["input_schema"], catalog[1]["inputSchema"]);
}

TEST(agent_tools_of_a_non_array_is_empty) {
  CHECK_EQ(agentTools(Json::Value(Json::nullValue)).size(), 0u);
}

// --- tool_result block construction ---------------------------------------------------------

TEST(tool_result_block_carries_the_text_under_the_matching_id) {
  const Json::Value block = toolResultBlock("toolu_7", ToolResult::text("done"));
  CHECK_EQ(block["type"].asString(), std::string("tool_result"));
  CHECK_EQ(block["tool_use_id"].asString(), std::string("toolu_7"));
  CHECK_EQ(block["content"].asString(), std::string("done"));
  CHECK_FALSE(block.isMember("is_error"));
}

TEST(tool_result_block_marks_a_failed_tool) {
  const Json::Value block = toolResultBlock("toolu_9", ToolResult::failure("no such node"));
  CHECK_EQ(block["content"].asString(), std::string("no such node"));
  CHECK(block["is_error"].asBool());
}

// --- read-only vs mutating classification ---------------------------------------------------

TEST(mutates_tree_treats_the_get_list_find_family_as_read_only) {
  CHECK_FALSE(mutatesTree("get_tree"));
  CHECK_FALSE(mutatesTree("get_diagnostics"));
  CHECK_FALSE(mutatesTree("list_trees"));
  CHECK_FALSE(mutatesTree("find_nodes"));
}

TEST(mutates_tree_treats_everything_else_including_the_unknown_as_a_change) {
  CHECK(mutatesTree("create_node"));
  CHECK(mutatesTree("change_edges"));
  CHECK(mutatesTree("delete_node"));
  CHECK(mutatesTree("update_nodes"));
  CHECK(mutatesTree("update_kind"));
  CHECK(mutatesTree("something_new"));  // unknown → conservative → a change
}

// --- The loop -------------------------------------------------------------------------------

TEST(drive_agent_runs_the_tools_and_returns_the_receipt_on_end_turn) {
  FakeToolHost host;
  host.catalog.push_back(declared("get_tree", "Read a roadmap."));
  host.catalog.push_back(declared("create_node", "Add a step."));

  FakeModel model;
  model.replies.push_back(toolUseReply("create_node", "toolu_1"));
  model.replies.push_back(textReply("end_turn", "Added 1 step under Backend"));

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("add a deploy step", kTree, kCaller, host, model.asCall(), rec.onStep(), rec.report());

  CHECK(outcome.ok);
  CHECK_EQ(outcome.edits, 1);
  CHECK_EQ(outcome.summary, std::string("Added 1 step under Backend"));
  CHECK_EQ(outcome.detail, std::string(""));
  CHECK_EQ(outcome.error, std::string(""));
  CHECK_EQ(rec.failures.size(), 0u);

  REQUIRE_EQ(rec.steps.size(), 1u);
  CHECK_EQ(rec.steps[0].tool, std::string("create_node"));
  CHECK(rec.steps[0].changedTree);
  CHECK_FALSE(rec.steps[0].failed);
  CHECK_EQ(rec.steps[0].note, std::string("create_node"));

  REQUIRE_EQ(host.calls.size(), 2u);
  CHECK_EQ(host.calls[0].first, std::string("get_tree"));
  CHECK_EQ(host.calls[1].first, std::string("create_node"));

  REQUIRE_EQ(model.requests.size(), 2u);
  CHECK_EQ(model.requests[0]["model"].asString(), std::string("claude-sonnet-5"));
  CHECK_EQ(model.requests[0]["max_tokens"].asInt(), 8000);
  CHECK_EQ(model.requests[0]["tools"], agentTools(catalogSeenBy(host)));
  CHECK(model.requests[0]["system"][0]["text"].asString().size() > 0);
  CHECK_EQ(model.requests[0]["system"][0]["cache_control"]["type"].asString(), std::string("ephemeral"));
  // The first user turn is promoted to a block so the conversation cache breakpoint has somewhere to sit.
  CHECK(model.requests[0]["messages"][0]["content"][0]["text"].asString().find("add a deploy step") !=
        std::string::npos);
  CHECK_EQ(model.requests[0]["messages"][0]["content"][0]["cache_control"]["type"].asString(),
           std::string("ephemeral"));

  const Json::Value& secondMessages = model.requests[1]["messages"];
  const Json::Value& lastTurn = secondMessages[secondMessages.size() - 1];
  CHECK_EQ(lastTurn["role"].asString(), std::string("user"));
  CHECK_EQ(lastTurn["content"][0]["type"].asString(), std::string("tool_result"));
  CHECK_EQ(lastTurn["content"][0]["tool_use_id"].asString(), std::string("toolu_1"));

  // The conversation cache breakpoint MOVES to the newest turn, which keeps the count under the four-per-request cap however long the loop runs.
  int marks = 0;
  for (const Json::Value& message : secondMessages)
    for (const Json::Value& block : message["content"])
      if (block.isMember("cache_control")) ++marks;
  CHECK_EQ(marks, 1);
  CHECK_FALSE(secondMessages[0]["content"][0].isMember("cache_control"));
  CHECK(lastTurn["content"][lastTurn["content"].size() - 1].isMember("cache_control"));
}

TEST(drive_agent_splits_a_multi_line_reply_into_receipt_and_why) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("end_turn", "I linked the two steps you named.\nLinked 2 steps"));

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("link them", kTree, kCaller, host, model.asCall(), rec.onStep(), rec.report());

  CHECK(outcome.ok);
  CHECK_EQ(outcome.summary, std::string("Linked 2 steps"));
  CHECK_EQ(outcome.detail, std::string("I linked the two steps you named."));
}

TEST(drive_agent_counts_only_successful_mutations_as_edits) {
  FakeToolHost host;
  host.responder = [](const std::string& name, const Json::Value&) -> ToolResult {
    if (name == "delete_node") return ToolResult::failure("node carries progress");
    return ToolResult::text("ok");
  };

  FakeModel model;
  model.replies.push_back(toolUseReply("delete_node", "toolu_1"));
  model.replies.push_back(textReply("end_turn", "Nothing deleted"));

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("remove that", kTree, kCaller, host, model.asCall(), rec.onStep(), rec.report());

  CHECK(outcome.ok);
  CHECK_EQ(outcome.edits, 0);
  REQUIRE_EQ(rec.steps.size(), 1u);
  CHECK(rec.steps[0].failed);
  CHECK_FALSE(rec.steps[0].changedTree);
  CHECK_EQ(rec.steps[0].note, std::string("delete_node failed: node carries progress"));
}

// A write that answers `unchanged` changed nothing: a step of the run that neither failed nor counts as an edit.
// Through a tend's scoped host over the real tools: an import that re-sends what the tree holds is no edit of the run,
// unless it carries a mark the caller does not hold yet: `unchanged` says the whole call changed nothing, and each
// progress row answers for its own mark. update_nodes is counted by the same read, so a mark it repeats is no edit
// either.
TEST(drive_agent_counts_an_echoed_import_as_no_edit_unless_it_sets_a_new_mark) {
  test::Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"}]})")).isError);
  ScopedToolHost scoped(h.tools, TreeId{"t"});
  const auto editsOf = [&](const char* tool, const char* input) {
    Json::Value call = toolUseReply(tool, "toolu_1");
    call["content"][0]["input"] = parse(input);
    FakeModel model;
    model.replies.push_back(call);
    model.replies.push_back(textReply("end_turn", "Done"));
    Recorder rec;
    return driveAgent("tend it", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report()).edits;
  };
  const char* marked = R"({"nodes":[{"id":"a","label":"A"}],"progress":[{"nodeId":"a","status":"complete"}]})";

  CHECK_EQ(editsOf("import_subgraph", R"({"nodes":[{"id":"a","label":"A"}]})"), 0);
  CHECK_EQ(editsOf("import_subgraph", marked), 1);
  CHECK_EQ(editsOf("import_subgraph", marked), 0);
  CHECK_EQ(editsOf("import_subgraph", R"({"nodes":[{"id":"a","label":"B"}]})"), 1);

  // update_nodes answers as an import does: `unchanged` when the whole call changed nothing, and a row per mark.
  CHECK_EQ(editsOf("update_nodes", R"({"updates":[{"nodeId":"a","status":"none"}]})"), 1);
  CHECK_EQ(editsOf("update_nodes", R"({"updates":[{"nodeId":"a","status":"none"}]})"), 0);
  CHECK_EQ(editsOf("update_nodes", R"({"updates":[{"nodeId":"a","label":"B","status":"none"}]})"), 0);
  CHECK_EQ(editsOf("update_nodes", R"({"updates":[{"nodeId":"a","label":"Alpha","status":"none"}]})"), 1);
}

// Under a tend, update_nodes marks that are the whole call fail the step with them; marks that fail after a tree op
// landed leave the step done and are told under their own name, at the tend's door — as are an import's cleared marks
// and, by the same two branches, its progress rows.
TEST(drive_agent_fails_a_step_whose_marks_are_the_call_and_reports_late_marks_at_its_door) {
  test::Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}]})")).isError);
  CHECK_FALSE(h.call("update_nodes", test::asUpdate(parse(R"({"nodeId":"b","status":"complete"})"))).isError);
  ScopedToolHost scoped(h.tools, TreeId{"t"});
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) {
    lines.push_back(line.operation + " " + line.product + " " + line.door + " " + line.outcome);
  });
  const auto stepOf = [&](const char* tool, const char* input) {
    Json::Value call = toolUseReply(tool, "toolu_1");
    call["content"][0]["input"] = parse(input);
    FakeModel model;
    model.replies.push_back(call);
    model.replies.push_back(textReply("end_turn", "Done"));
    Recorder rec;
    const AgentOutcome outcome =
        driveAgent("tend it", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report());
    return std::to_string(outcome.edits) + " edits, failed " + std::to_string(rec.steps.at(0).failed);
  };

  h.progressRepo.writesFail = true;
  CHECK_EQ(stepOf("update_nodes", R"({"updates":[{"nodeId":"a","status":"complete"}]})"), std::string("0 edits, failed 1"));
  CHECK_EQ(stepOf("update_nodes", R"({"updates":[{"nodeId":"a","label":"Alpha","status":"complete"}]})"),
           std::string("1 edits, failed 0"));
  CHECK_EQ(stepOf("import_subgraph", R"({"nodes":[],"tombstone":["b"]})"), std::string("1 edits, failed 0"));
  CHECK_EQ(stepOf("import_subgraph", R"({"nodes":[{"id":"c","label":"C"}],"progress":[{"nodeId":"a","status":"complete"}]})"),
           std::string("1 edits, failed 0"));
  CHECK_EQ(stepOf("import_subgraph", R"({"nodes":[],"progress":[{"nodeId":"a","status":"complete"}]})"),
           std::string("0 edits, failed 1"));
  h.progressRepo.writesFail = false;
  installWriteSink({});

  CHECK_EQ(lines, (std::vector<std::string>{
                      "roadmap.update_nodes roadmap Coach failed",
                      "roadmap.update_nodes.marks roadmap Coach failed",
                      "roadmap.update_nodes roadmap Coach ok",
                      "roadmap.import.clear_marks roadmap Coach failed",
                      "roadmap.import_subgraph roadmap Coach ok",
                      "roadmap.import.marks roadmap Coach failed",
                      "roadmap.import_subgraph roadmap Coach ok",
                      "roadmap.import_subgraph roadmap Coach failed",
                  }));
}

// A tend links and unlinks nodes through change_edges, the one edge tool: a call that changes an edge is one edit of
// the run, and one naming only an edge the tree holds, or one it does not, is none. Each call writes its line as
// roadmap.change_edges, door Coach, and the tree holds what the run left.
TEST(drive_agent_links_and_unlinks_through_change_edges_and_counts_what_changed) {
  test::Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"},
    {"id":"c","label":"C"}]})")).isError);
  ScopedToolHost scoped(h.tools, TreeId{"t"});
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) {
    lines.push_back(line.operation + " " + line.product + " " + line.door + " " + line.outcome);
  });
  const auto editsOf = [&](const char* input) {
    Json::Value call = toolUseReply("change_edges", "toolu_1");
    call["content"][0]["input"] = parse(input);
    FakeModel model;
    model.replies.push_back(call);
    model.replies.push_back(textReply("end_turn", "Done"));
    Recorder rec;
    return driveAgent("tend it", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report()).edits;
  };

  CHECK_EQ(editsOf(R"({"add":[{"from":"a","to":"b"},{"from":"b","to":"c"}]})"), 1);
  CHECK_EQ(editsOf(R"({"add":[{"from":"a","to":"b"}]})"), 0);
  CHECK_EQ(editsOf(R"({"remove":[{"from":"a","to":"b"}],"add":[{"from":"a","to":"c"}]})"), 1);
  CHECK_EQ(editsOf(R"({"remove":[{"from":"a","to":"b"}]})"), 0);
  installWriteSink({});

  CHECK_EQ(lines, (std::vector<std::string>(4, "roadmap.change_edges roadmap Coach ok")));
  Json::Value shape(Json::objectValue);
  shape["fields"] = test::list({"id", "prerequisites"});
  CHECK_EQ(test::body(h.call("get_tree", shape))["tree"]["nodes"],
           parse(R"([{"id":"a","prerequisites":[]},{"id":"b","prerequisites":[]},{"id":"c","prerequisites":["a","b"]}])"));
}

// A tend renames, rebriefs and re-hues a kind through update_kind: each call that changes the kind is one edit of the
// run, one that sends what the kind holds is none, and each writes its line as roadmap.update_kind, door Coach.
TEST(drive_agent_changes_a_kind_through_update_kind_and_counts_what_changed) {
  test::Harness h;
  CHECK_FALSE(h.call("add_kind", parse(R"({"id":"k","hue":"sky","label":"K","description":"Brief."})")).isError);
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","kind":"k"}]})")).isError);
  ScopedToolHost scoped(h.tools, TreeId{"t"});
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) {
    lines.push_back(line.operation + " " + line.product + " " + line.door + " " + line.outcome);
  });
  const auto editsOf = [&](const char* input) {
    Json::Value call = toolUseReply("update_kind", "toolu_1");
    call["content"][0]["input"] = parse(input);
    FakeModel model;
    model.replies.push_back(call);
    model.replies.push_back(textReply("end_turn", "Done"));
    Recorder rec;
    return driveAgent("tend it", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report()).edits;
  };

  CHECK_EQ(editsOf(R"({"id":"k","label":"Kay"})"), 1);
  CHECK_EQ(editsOf(R"({"id":"k","description":"New brief."})"), 1);
  CHECK_EQ(editsOf(R"({"id":"k","hue":"plum"})"), 1);
  CHECK_EQ(editsOf(R"({"id":"k","label":"Kay","description":"New brief.","hue":"plum"})"), 0);
  installWriteSink({});

  CHECK_EQ(lines, (std::vector<std::string>(4, "roadmap.update_kind roadmap Coach ok")));
  Json::Value shape(Json::objectValue);
  shape["fields"] = test::list({"id", "color", "kind"});
  shape["kindFields"] = test::list({"id", "hue", "label", "description"});
  const Json::Value tree = test::body(h.call("get_tree", shape))["tree"];
  CHECK_EQ(tree["kinds"], parse(R"([{"id":"k","hue":"plum","label":"Kay","description":"New brief."}])"));
  CHECK_EQ(tree["nodes"], parse(R"([{"id":"a","color":"plum","kind":"k"}])"));
}

// A tend whose model adds a node without naming its kind, on a tree where no kind wears terracotta, is answered the
// refusal as a failed step and has made no edit; the sentence it is handed lists the legend, so its next call can name one.
TEST(drive_agent_fails_the_step_that_creates_a_node_naming_no_kind_where_no_kind_wears_terracotta) {
  test::Harness h;
  h.trees.byId["t"].legend =
      Legend({{KindId{"read"}, NodeColor::sky, "Reading"}, {KindId{"ship"}, NodeColor::plum, "Shipping"}}, Hlc{1, 0, "seed"})
          .exportState();
  ScopedToolHost scoped(h.tools, TreeId{"t"});
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) {
    if (line.operation != "roadmap.get_tree") lines.push_back(line.operation + " " + line.door + " " + line.outcome);
  });
  const auto stepOf = [&](const char* tool, const char* input) {
    Json::Value call = toolUseReply(tool, "toolu_1");
    call["content"][0]["input"] = parse(input);
    FakeModel model;
    model.replies.push_back(call);
    model.replies.push_back(textReply("end_turn", "Done"));
    Recorder rec;
    const AgentOutcome outcome =
        driveAgent("tend it", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report());
    const Json::Value answered = model.requests.at(1)["messages"][model.requests.at(1)["messages"].size() - 1]["content"][0];
    return std::to_string(outcome.edits) + " edits, changed " + std::to_string(rec.steps.at(0).changedTree) +
           ", failed " + std::to_string(rec.steps.at(0).failed) + " | " + answered["content"].asString();
  };

  CHECK_EQ(stepOf("create_node", R"({"label":"Hull"})"),
           std::string("0 edits, changed 0, failed 1 | create_node: the node names neither \"kind\" nor \"color\", and no "
                       "kind of this tree wears terracotta, the hue a new node takes without them — name one of the "
                       "legend's kinds: \"read\" (Reading), \"ship\" (Shipping)"));
  CHECK_EQ(stepOf("import_subgraph", R"({"nodes":[{"id":"mast","label":"Mast"}]})"),
           std::string("0 edits, changed 0, failed 1 | import_subgraph: nodes[0] \"mast\" names neither \"kind\" nor "
                       "\"color\", and no kind of this tree wears terracotta, the hue a new node takes without them — "
                       "name one of the legend's kinds: \"read\" (Reading), \"ship\" (Shipping)"));
  CHECK(h.trees.byId["t"].state == GraphState{});
  CHECK(stepOf("create_node", R"({"label":"Hull","kind":"ship"})").rfind("1 edits, changed 1, failed 0 | ", 0) == 0);
  installWriteSink({});
  CHECK_EQ(lines, (std::vector<std::string>{"roadmap.create_node Coach kind-unnamed",
                                            "roadmap.import_subgraph Coach kind-unnamed",
                                            "roadmap.create_node Coach ok"}));
}

// A tend renames, recolours, annotates and marks a node through update_nodes, the one tool that edits or marks nodes,
// and is not offered `opens`: each call that changes the node is one edit of the run, one that sends what the node
// holds is none, and each writes its line as roadmap.update_nodes, door Coach.
TEST(drive_agent_edits_and_marks_a_node_through_update_nodes_and_counts_what_changed) {
  test::Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"}]})")).isError);
  ScopedToolHost scoped(h.tools, TreeId{"t"});
  std::vector<std::string> lines;
  installWriteSink([&](const WriteCompletion& line) {
    lines.push_back(line.operation + " " + line.product + " " + line.door + " " + line.outcome);
  });
  std::vector<std::string> offeredRow;
  const auto editsOf = [&](const char* input) {
    Json::Value call = toolUseReply("update_nodes", "toolu_1");
    call["content"][0]["input"] = parse(input);
    FakeModel model;
    model.replies.push_back(call);
    model.replies.push_back(textReply("end_turn", "Done"));
    Recorder rec;
    const int edits =
        driveAgent("tend it", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report()).edits;
    for (const Json::Value& tool : model.requests.at(0)["tools"])
      if (tool["name"].asString() == "update_nodes")
        offeredRow = tool["input_schema"]["properties"]["updates"]["items"]["properties"].getMemberNames();
    return edits;
  };

  CHECK_EQ(editsOf(R"({"updates":[{"nodeId":"a","label":"Alpha"}]})"), 1);
  CHECK_EQ(editsOf(R"({"updates":[{"nodeId":"a","color":"plum"}]})"), 1);
  CHECK_EQ(editsOf(R"({"updates":[{"nodeId":"a","description":"Why it matters.","links":[{"url":"https://a.example"}]}]})"), 1);
  CHECK_EQ(editsOf(R"({"updates":[{"nodeId":"a","status":"complete"}]})"), 1);
  CHECK_EQ(editsOf(R"({"updates":[{"nodeId":"a","label":"Alpha","color":"plum","description":"Why it matters.",
    "links":[{"url":"https://a.example"}],"status":"complete"}]})"), 0);
  installWriteSink({});

  CHECK_EQ(offeredRow, (std::vector<std::string>{"addLinks", "appendDescription", "color", "description", "icon",
                                                 "kind", "label", "links", "nodeId", "outOfOrder", "status"}));
  CHECK_EQ(lines, (std::vector<std::string>(5, "roadmap.update_nodes roadmap Coach ok")));
  Json::Value shape(Json::objectValue);
  shape["fields"] = test::list({"id", "label", "color", "description", "links", "status"});
  CHECK_EQ(test::body(h.call("get_tree", shape))["tree"]["nodes"],
           parse(R"([{"id":"a","label":"Alpha","color":"plum","description":"Why it matters.",
             "links":[{"url":"https://a.example"}],"status":"complete"}])"));
}

// A tend is offered no get_health, tidy or prune, which the server no longer has, and still reads the tree's diagnostics:
// a read that changes nothing and is no edit of the run.
TEST(drive_agent_is_offered_no_health_tidy_or_prune_and_still_reads_diagnostics) {
  test::Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A","prerequisites":["ghost"]}]})")).isError);
  ScopedToolHost scoped(h.tools, TreeId{"t"});
  FakeModel model;
  model.replies.push_back(toolUseReply("get_diagnostics", "toolu_1"));
  model.replies.push_back(textReply("end_turn", "Read the tree"));

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("check it", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report());

  std::vector<std::string> offered;
  for (const Json::Value& tool : model.requests.at(0)["tools"]) offered.push_back(tool["name"].asString());
  CHECK_EQ(offered, (std::vector<std::string>{"get_nodes", "update_nodes", "change_edges", "get_tree", "get_diagnostics",
                                              "get_progress", "find_nodes", "create_node", "delete_node", "add_kind",
                                              "remove_kind", "update_kind", "import_subgraph"}));
  CHECK(outcome.ok);
  CHECK_EQ(outcome.edits, 0);
  REQUIRE_EQ(rec.steps.size(), 1u);
  CHECK_EQ(std::vector<bool>({rec.steps[0].failed, rec.steps[0].changedTree}), std::vector<bool>({false, false}));
  const Json::Value& lastTurn = model.requests.at(1)["messages"][model.requests.at(1)["messages"].size() - 1];
  CHECK_EQ(parse(lastTurn["content"][0]["content"].asString())["dangling"], parse(R"([{"from":"ghost","to":"a"}])"));
}

// A dry run writes nothing, so it is no edit of the run, for every tool that takes `dryRun`, though its preview says the
// tree would change; the same call sent for real is one edit.
TEST(drive_agent_counts_no_edit_for_a_dry_run) {
  test::Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}]})")).isError);
  ScopedToolHost scoped(h.tools, TreeId{"t"});
  const auto stepOf = [&](const char* tool, const std::string& input) {
    Json::Value call = toolUseReply(tool, "toolu_1");
    call["content"][0]["input"] = parse(input);
    FakeModel model;
    model.replies.push_back(call);
    model.replies.push_back(textReply("end_turn", "Done"));
    Recorder rec;
    const AgentOutcome outcome =
        driveAgent("tend it", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report());
    return std::to_string(outcome.edits) + " edits, changed " + std::to_string(rec.steps.at(0).changedTree) +
           ", failed " + std::to_string(rec.steps.at(0).failed);
  };
  const auto held = [&] {
    Json::Value shape(Json::objectValue);
    shape["fields"] = test::list({"id", "label", "prerequisites", "status"});
    return test::body(h.call("get_tree", shape))["tree"]["nodes"];
  };
  const std::vector<std::pair<const char*, std::string>> writes = {
      {"update_nodes", R"("updates":[{"nodeId":"a","label":"Alpha","status":"complete"}])"},
      {"change_edges", R"("add":[{"from":"a","to":"b"}])"},
      {"import_subgraph", R"("nodes":[{"id":"c","label":"C"}],"progress":[{"nodeId":"b","status":"complete"}])"}};
  const Json::Value before = held();

  for (const auto& [tool, fields] : writes)
    CHECK_EQ(stepOf(tool, "{\"dryRun\":true," + fields + "}"), std::string("0 edits, changed 0, failed 0"));
  CHECK_EQ(held(), before);

  for (const auto& [tool, fields] : writes)
    CHECK_EQ(stepOf(tool, "{" + fields + "}"), std::string("1 edits, changed 1, failed 0"));
  CHECK_EQ(held(), parse(R"([{"id":"a","label":"Alpha","prerequisites":[],"status":"complete"},
    {"id":"b","label":"B","prerequisites":["a"],"status":"complete"},{"id":"c","label":"C","prerequisites":[],"status":"none"}])"));
}

// A refused mark wrote nothing, so a write whose every mark was refused on a step that opens a tree, with no tree op
// landed, is no edit of the run: a mark alone, a mark beside an echoed label, and an import that grafts nothing. Beside a
// mark that lands, the same refusal is one edit.
TEST(drive_agent_counts_no_edit_for_a_write_whose_every_mark_was_refused) {
  test::Harness h;
  h.trees.byId["t_sub"] = StoredTree{LooseGraph().exportState(), LegendState{}, {"Deep dive", {}}, 0, h.caller};
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"idea","label":"Idea","opens":"t_sub"},
      {"id":"a","label":"A"}]})")).isError);
  ScopedToolHost scoped(h.tools, TreeId{"t"});
  const auto stepOf = [&](const char* tool, const char* input) {
    Json::Value call = toolUseReply(tool, "toolu_1");
    call["content"][0]["input"] = parse(input);
    FakeModel model;
    model.replies.push_back(call);
    model.replies.push_back(textReply("end_turn", "Done"));
    Recorder rec;
    const AgentOutcome outcome =
        driveAgent("tend it", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report());
    return std::to_string(outcome.edits) + " edits, changed " + std::to_string(rec.steps.at(0).changedTree) +
           ", failed " + std::to_string(rec.steps.at(0).failed);
  };
  const Seq head = h.trees.byId["t"].head;

  CHECK_EQ(stepOf("update_nodes", R"({"updates":[{"nodeId":"idea","status":"complete"}]})"),
           std::string("0 edits, changed 0, failed 0"));
  CHECK_EQ(stepOf("update_nodes", R"({"updates":[{"nodeId":"idea","label":"Idea","status":"complete"}]})"),
           std::string("0 edits, changed 0, failed 0"));
  CHECK_EQ(stepOf("import_subgraph", R"({"nodes":[],"progress":[{"nodeId":"idea","status":"complete"}]})"),
           std::string("0 edits, changed 0, failed 0"));
  CHECK_EQ(h.trees.byId["t"].head, head);
  CHECK(h.progressRepo.byKey.empty());

  CHECK_EQ(stepOf("update_nodes", R"({"updates":[{"nodeId":"idea","status":"complete"},{"nodeId":"a","status":"complete"}]})"),
           std::string("1 edits, changed 1, failed 0"));
  CHECK_EQ(h.progressRepo.byKey.size(), 1u);
}

// Through a tend's scoped host over the real tools, every write that changes nothing answers `unchanged` and is no edit
// of the run: an update_nodes and an edge batch that change nothing and an echoed import, beside one real rename.
TEST(drive_agent_counts_one_edit_among_writes_that_changed_nothing) {
  test::Harness h;
  CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B",
    "prerequisites":["a"]}]})")).isError);
  ScopedToolHost scoped(h.tools, TreeId{"t"});
  FakeModel model;
  int id = 0;
  for (const auto& [tool, input] : std::vector<std::pair<const char*, const char*>>{
           {"update_nodes", R"({"updates":[{"nodeId":"a","label":"A"},{"nodeId":"b","label":"B"}]})"},
           {"change_edges", R"({"add":[{"from":"a","to":"b"}]})"},
           {"import_subgraph", R"({"nodes":[{"id":"a","label":"A"}]})"},
           {"update_nodes", R"({"updates":[{"nodeId":"a","label":"Alpha"}]})"}}) {
    Json::Value call = toolUseReply(tool, ("toolu_" + std::to_string(++id)).c_str());
    call["content"][0]["input"] = parse(input);
    model.replies.push_back(call);
  }
  model.replies.push_back(textReply("end_turn", "Renamed 1 step"));

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("tidy it", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report());
  CHECK_EQ(outcome.edits, 1);
  std::vector<bool> changed;
  for (const AgentStep& step : rec.steps) changed.push_back(step.changedTree);
  CHECK_EQ(changed, (std::vector<bool>{false, false, false, true}));
}

TEST(drive_agent_counts_no_edit_for_a_write_that_changed_nothing) {
  FakeToolHost host;
  host.responder = [](const std::string& name, const Json::Value&) -> ToolResult {
    Json::Value reply(Json::objectValue);
    reply["applied"] = true;
    reply["seq"] = 3;
    if (name == "change_edges") reply["unchanged"] = true;
    return ToolResult::json(reply);
  };

  FakeModel model;
  model.replies.push_back(toolUseReply("change_edges", "toolu_1"));
  model.replies.push_back(toolUseReply("update_nodes", "toolu_2"));
  model.replies.push_back(textReply("end_turn", "Renamed 1 step"));

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("tidy the names", kTree, kCaller, host, model.asCall(), rec.onStep(), rec.report());

  CHECK(outcome.ok);
  CHECK_EQ(outcome.edits, 1);
  REQUIRE_EQ(rec.steps.size(), 2u);
  CHECK_EQ(std::vector<bool>({rec.steps[0].failed, rec.steps[0].changedTree, rec.steps[1].failed, rec.steps[1].changedTree}),
           std::vector<bool>({false, false, false, true}));
}

// A reply that says it applied nothing wrote nothing, whatever else it answers: no edit of the run.
TEST(drive_agent_counts_no_edit_for_a_reply_that_applied_nothing) {
  FakeToolHost host;
  host.responder = [](const std::string& name, const Json::Value&) -> ToolResult {
    Json::Value reply(Json::objectValue);
    reply["applied"] = name != "update_nodes";
    reply["seq"] = 3;
    return ToolResult::json(reply);
  };

  FakeModel model;
  model.replies.push_back(toolUseReply("update_nodes", "toolu_1"));
  model.replies.push_back(toolUseReply("change_edges", "toolu_2"));
  model.replies.push_back(textReply("end_turn", "Linked 1 step"));

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("link them", kTree, kCaller, host, model.asCall(), rec.onStep(), rec.report());

  CHECK(outcome.ok);
  CHECK_EQ(outcome.edits, 1);
  REQUIRE_EQ(rec.steps.size(), 2u);
  CHECK_EQ(std::vector<bool>({rec.steps[0].failed, rec.steps[0].changedTree, rec.steps[1].failed, rec.steps[1].changedTree}),
           std::vector<bool>({false, false, false, true}));
}

TEST(drive_agent_counts_an_edit_for_a_write_whose_answer_is_no_object) {
  FakeToolHost host;
  host.responder = [](const std::string&, const Json::Value&) -> ToolResult {
    Json::Value reply(Json::arrayValue);
    reply.append(1);
    return ToolResult::json(reply);
  };

  FakeModel model;
  model.replies.push_back(toolUseReply("update_nodes", "toolu_1"));
  model.replies.push_back(textReply("end_turn", "Renamed 1 step"));

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("tidy the names", kTree, kCaller, host, model.asCall(), rec.onStep(), rec.report());

  CHECK(outcome.ok);
  CHECK_EQ(outcome.edits, 1);
  REQUIRE_EQ(rec.steps.size(), 1u);
  CHECK_EQ(std::vector<bool>({rec.steps[0].failed, rec.steps[0].changedTree}), std::vector<bool>({false, true}));
}

TEST(drive_agent_treats_the_iteration_cap_as_a_failure) {
  FakeToolHost host;
  FakeModel model;
  model.whenExhausted = toolUseReply("create_node", "toolu_x");  // never says end_turn

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("build forever", kTree, kCaller, host, model.asCall(), rec.onStep(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("hit the 12-iteration cap without the model finishing"));
  CHECK_EQ(outcome.edits, 12);
  CHECK_EQ(model.requests.size(), 12u);
  CHECK_EQ(rec.steps.size(), 12u);
  REQUIRE_EQ(rec.failures.size(), 1u);
  CHECK_EQ(rec.failures[0], std::string("agent.run | hit the 12-iteration cap without the model finishing"));
}

TEST(drive_agent_fails_and_reports_when_the_model_stops_early) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("max_tokens", "# Half a"));

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("plan it", kTree, kCaller, host, model.asCall(), rec.onStep(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("the model stopped early (stop_reason: max_tokens)"));
  REQUIRE_EQ(rec.failures.size(), 1u);
  CHECK_EQ(rec.failures[0], std::string("agent.run | the model stopped early (stop_reason: max_tokens)"));
}

TEST(drive_agent_fails_and_reports_on_an_unreadable_upstream_reply) {
  FakeToolHost host;
  FakeModel model;  // no replies, no whenExhausted → nullopt on the first call

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("do something", kTree, kCaller, host, model.asCall(), rec.onStep(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("the model call failed or returned an unreadable reply"));
  CHECK_EQ(rec.failures.size(), 1u);
}

TEST(drive_agent_fails_when_the_tree_cannot_be_read) {
  FakeToolHost host;
  host.responder = [](const std::string&, const Json::Value&) {
    return ToolResult::failure("private tree");
  };
  FakeModel model;

  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("tidy it", kTree, kCaller, host, model.asCall(), rec.onStep(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("could not read the tree before tending"));
  CHECK_EQ(model.requests.size(), 0u);
  REQUIRE_EQ(rec.failures.size(), 1u);
  CHECK_EQ(rec.failures[0], std::string("agent.setup | could not read the tree before tending"));
}

TEST(anthropic_agent_without_a_key_is_unconfigured_and_never_calls_upstream) {
  AnthropicAgent agent{""};
  CHECK_FALSE(agent.configured());

  FakeToolHost host;
  Recorder rec;
  const AgentOutcome outcome = agent.run("anything", kTree, kCaller, host, rec.onStep());
  CHECK_FALSE(outcome.ok);
  CHECK_EQ(host.calls.size(), 0u);
}

TEST(anthropic_agent_with_a_key_reports_configured) {
  AnthropicAgent agent{"sk-ant-test"};
  CHECK(agent.configured());
}

// --- The meter around the loop ---------------------------------------------------------------

namespace {

struct RecordedSpend : UsageSink {
  std::vector<AiSpend> rows;
  void record(const AiSpend& spend) noexcept override { rows.push_back(spend); }
};

Json::Value billed(Json::Value reply, long long input, long long output, long long cacheRead) {
  Json::Value usage(Json::objectValue);
  usage["input_tokens"] = static_cast<Json::Int64>(input);
  usage["output_tokens"] = static_cast<Json::Int64>(output);
  usage["cache_read_input_tokens"] = static_cast<Json::Int64>(cacheRead);
  reply["usage"] = usage;
  return reply;
}

AiSpend tendFrame() {
  AiSpend frame;
  frame.user = kCaller;
  frame.product = "roadmap";
  frame.operation = "tend";
  frame.model = "claude-sonnet-5";
  frame.runId = "tend-abc";
  return frame;
}

}

TEST(metered_writes_one_row_per_turn_with_a_stable_run_id_and_a_climbing_iteration) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(billed(toolUseReply("create_node", "toolu_1"), 9000, 120, 0));
  model.replies.push_back(billed(toolUseReply("change_edges", "toolu_2"), 400, 90, 9000));
  model.replies.push_back(billed(textReply("end_turn", "Added 2 steps"), 500, 60, 9400));

  auto ledger = std::make_shared<RecordedSpend>();
  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("build it", kTree, kCaller, host,
                 metered(model.asCall(), tendFrame(), nullptr, ledger, rec.report()),
                 rec.onStep(), rec.report());

  CHECK(outcome.ok);
  REQUIRE_EQ(ledger->rows.size(), std::size_t{3});
  for (std::size_t turn = 0; turn < 3; ++turn) {
    // One run id across all three, so a conversation can be summed as the single act it was.
    CHECK_EQ(ledger->rows[turn].runId, std::string("tend-abc"));
    CHECK_EQ(ledger->rows[turn].iteration, static_cast<int>(turn));
    CHECK_EQ(ledger->rows[turn].product, std::string("roadmap"));
    CHECK_EQ(ledger->rows[turn].operation, std::string("tend"));
    CHECK_EQ(ledger->rows[turn].model, std::string("claude-sonnet-5"));
    CHECK(ledger->rows[turn].user == std::optional<UserId>{kCaller});
    CHECK_EQ(ledger->rows[turn].outcome, std::string("ok"));
  }
  CHECK_EQ(ledger->rows[0].tokens.input, 9000LL);
  CHECK_EQ(ledger->rows[0].tokens.cacheRead, 0LL);
  CHECK_EQ(ledger->rows[1].tokens.cacheRead, 9000LL);
  CHECK_EQ(ledger->rows[2].tokens.output, 60LL);
}

TEST(metered_records_all_twelve_turns_of_a_run_that_hit_the_cap) {
  FakeToolHost host;
  FakeModel model;
  model.whenExhausted = billed(toolUseReply("create_node", "toolu_x"), 9000, 200, 0);

  auto ledger = std::make_shared<RecordedSpend>();
  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("build forever", kTree, kCaller, host,
                 metered(model.asCall(), tendFrame(), nullptr, ledger, rec.report()),
                 rec.onStep(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(ledger->rows.size(), std::size_t{12});
  CHECK_EQ(ledger->rows[11].iteration, 11);
  CHECK_EQ(ledger->rows[11].runId, std::string("tend-abc"));
}

TEST(metered_records_a_turn_the_model_stopped_early_as_truncated) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(billed(textReply("max_tokens", "# Half a"), 9000, 8000, 0));

  auto ledger = std::make_shared<RecordedSpend>();
  Recorder rec;
  driveAgent("plan it", kTree, kCaller, host,
             metered(model.asCall(), tendFrame(), nullptr, ledger, rec.report()), rec.onStep(),
             rec.report());

  REQUIRE_EQ(ledger->rows.size(), std::size_t{1});
  CHECK_EQ(ledger->rows[0].outcome, std::string("truncated"));
  CHECK_EQ(ledger->rows[0].tokens.output, 8000LL);
}

TEST(metered_records_a_turn_that_never_landed_as_transport) {
  FakeToolHost host;
  FakeModel model;   // no replies, no whenExhausted → nullopt on the first call

  auto ledger = std::make_shared<RecordedSpend>();
  Recorder rec;
  driveAgent("do something", kTree, kCaller, host,
             metered(model.asCall(), tendFrame(), nullptr, ledger, rec.report()), rec.onStep(),
             rec.report());

  REQUIRE_EQ(ledger->rows.size(), std::size_t{1});
  CHECK_EQ(ledger->rows[0].outcome, std::string("transport"));
  CHECK_EQ(ledger->rows[0].tokens.input, 0LL);
}

TEST(metered_over_the_fuse_refuses_the_turn_before_it_reaches_the_vendor) {
  FakeToolHost host;
  FakeModel model;
  model.whenExhausted = billed(toolUseReply("create_node", "toolu_x"), 9000, 200, 0);

  auto fuse = std::make_shared<AiFuse>(1'000);
  fuse->spent(2'000, nowMs());
  auto ledger = std::make_shared<RecordedSpend>();
  Recorder rec;
  const AgentOutcome outcome =
      driveAgent("build it", kTree, kCaller, host,
                 metered(model.asCall(), tendFrame(), fuse, ledger, rec.report()), rec.onStep(),
                 rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(model.requests.size(), 0u);
  CHECK_EQ(ledger->rows.size(), 0u);
  REQUIRE_EQ(rec.failures.size(), 2u);
  CHECK(rec.failures[0].rfind("ai.fuse | over the hourly spend ceiling", 0) == 0);
  CHECK_EQ(rec.failures[1],
           std::string("agent.run | the model call failed or returned an unreadable reply"));
}

TEST(metered_charges_the_fuse_what_each_turn_cost) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(billed(textReply("end_turn", "Added 1 step"), 1000, 100, 2000));

  auto fuse = std::make_shared<AiFuse>(kHourlyFuseNanos);
  Recorder rec;
  driveAgent("add one", kTree, kCaller, host,
             metered(model.asCall(), tendFrame(), fuse, nullptr, rec.report()), rec.onStep(),
             rec.report());

  // Sonnet 5: 2000 nanos in, 10000 out, cache reads a tenth of input.
  CHECK_EQ(fuse->trailingNanos(nowMs()), 1000 * 2'000 + 100 * 10'000 + 2000 * 200);
}

TEST(metered_denial_signal_names_each_invocation_and_clears_on_recovery) {
  const auto at = nowMs();
  auto fuse = std::make_shared<AiFuse>(1000, 1000);
  fuse->spent(2000, at + 1000);
  int calls = 0;
  int denials = 0;
  int reports = 0;
  const auto call = metered([&](const Json::Value&) -> std::optional<Json::Value> {
    ++calls;
    return std::nullopt;
  }, tendFrame(), fuse, nullptr, [&](const std::string& where, const std::string&) {
    CHECK_EQ(where, std::string("ai.fuse"));
    ++reports;
  }, [&] { ++denials; });

  CHECK_FALSE(call(Json::Value{}).has_value());
  CHECK_FALSE(call(Json::Value{}).has_value());
  CHECK_EQ(calls, 0);
  CHECK_EQ(denials, 2);
  CHECK_EQ(reports, 1);
  CHECK_EQ(fuse->trailingNanos(at + 2001), 0);
  CHECK(fuse->tripped());
  CHECK_FALSE(call(Json::Value{}).has_value());
  CHECK_EQ(calls, 1);
  CHECK_EQ(denials, 2);
  CHECK_EQ(reports, 1);
}

// A tend that deletes a marked node clears its owner's mark and nobody else's; with the progress store down the step
// fails and deletes nothing, so the run counts no edit and the node is still there for the next run.
TEST(drive_agent_deletes_a_marked_node_through_the_progress_store_or_not_at_all) {
  for (const bool storeDown : {true, false}) {
    test::Harness h;
    h.trees.byId["t"].visibility = Visibility::public_;
    CHECK_FALSE(h.call("import_subgraph", parse(R"({"nodes":[{"id":"a","label":"A"}]})")).isError);
    CHECK_FALSE(h.call("update_nodes", test::asUpdate(parse(R"({"nodeId":"a","status":"complete"})"))).isError);
    const ToolCaller stranger{fake::uid("stranger"), ToolScope::everything()};
    CHECK_FALSE(h.tools.callTool("update_nodes", parse(R"({"treeId":"t","updates":[{"nodeId":"a","status":"complete"}]})"), stranger)
                    .isError);
    ScopedToolHost scoped(h.tools, TreeId{"t"});
    Json::Value call = toolUseReply("delete_node", "toolu_1");
    call["content"][0]["input"] = parse(R"({"nodeId":"a"})");
    FakeModel model;
    model.replies.push_back(call);
    model.replies.push_back(textReply("end_turn", "Removed 1 step"));
    Recorder rec;

    h.progressRepo.writesFail = storeDown;
    const AgentOutcome outcome =
        driveAgent("remove A", TreeId{"t"}, h.caller, scoped, model.asCall(), rec.onStep(), rec.report());
    h.progressRepo.writesFail = false;
    const auto progressOf = [&](const ToolCaller& who) {  // as the store holds it: get_progress hides a deleted node's
      const Progress stored = h.progress.progressOf(TreeId{"t"}, who.user);
      Json::Value marks = parse(R"({"completed":[],"cleared":[]})");
      for (const NodeId& node : stored.completed) marks["completed"].append(node.str());
      for (const NodeId& node : stored.cleared) marks["cleared"].append(node.str());
      return marks;
    };
    REQUIRE_EQ(rec.steps.size(), 1u);
    CHECK_EQ(outcome.edits, storeDown ? 0 : 1);
    CHECK_EQ(rec.steps[0].failed, storeDown);
    CHECK_EQ(h.registry.open(TreeId{"t"})->hasNode(NodeId{"a"}), storeDown);
    CHECK_EQ(progressOf(h.actor), parse(storeDown ? R"({"completed":["a"],"cleared":[]})"
                                                  : R"({"completed":[],"cleared":["a"]})"));
    CHECK_EQ(progressOf(stranger), parse(R"({"completed":["a"],"cleared":[]})"));
  }
}
