#include "adapters/llm/AnthropicAgent.h"

#include "test/testing.h"

#include <optional>
#include <string>
#include <vector>

using namespace wm;

namespace {

// A ToolHost the test scripts: it answers listTools() from a fixed catalog and every callTool
// through a supplied responder, recording each call so the loop's tool traffic is observable.
struct FakeToolHost : ToolHost {
  Json::Value catalog{Json::arrayValue};
  std::vector<std::pair<std::string, Json::Value>> calls;
  std::function<ToolResult(const std::string&, const Json::Value&)> responder;

  Json::Value listTools() const override { return catalog; }

  ToolResult callTool(const std::string& name, const Json::Value& arguments, const UserId&) override {
    calls.push_back({name, arguments});
    if (responder) return responder(name, arguments);
    return ToolResult::text("ok");
  }
};

// A scripted MessagesCall: it hands out `replies` one per iteration, then falls back to
// `whenExhausted` (a repeating reply, e.g. for the cap) or nullopt (an upstream failure). Every
// request the loop sends is recorded.
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

}

// --- Tool-schema translation ---------------------------------------------------------------

TEST(agent_tools_rename_inputSchema_to_input_schema_and_keep_the_rest) {
  Json::Value catalog(Json::arrayValue);
  catalog.append(mcpTool("get_tree", "Read a roadmap."));
  catalog.append(mcpTool("create_node", "Add a step."));

  const Json::Value translated = agentTools(catalog);

  CHECK_EQ(translated.size(), 2u);
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

TEST(mutates_tree_counts_describe_kind_which_writes_despite_its_name) {
  // "Set a legend kind's description" — it reads like an inspector but it mutates, so an
  // edit-only tend that only re-describes a kind still counts as having changed the tree.
  CHECK(mutatesTree("describe_kind"));
}

TEST(mutates_tree_treats_everything_else_including_the_unknown_as_a_change) {
  CHECK(mutatesTree("create_node"));
  CHECK(mutatesTree("connect"));
  CHECK(mutatesTree("delete_node"));
  CHECK(mutatesTree("set_progress"));
  CHECK(mutatesTree("rename_node"));
  CHECK(mutatesTree("something_new"));  // unknown → conservative → a change
}

// --- The loop -------------------------------------------------------------------------------

TEST(drive_agent_runs_the_tools_and_returns_the_receipt_on_end_turn) {
  FakeToolHost host;
  host.catalog.append(mcpTool("get_tree", "Read a roadmap."));
  host.catalog.append(mcpTool("create_node", "Add a step."));

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

  // One step fired, as it happened, for the one tool the model asked for.
  CHECK_EQ(rec.steps.size(), 1u);
  CHECK_EQ(rec.steps[0].tool, std::string("create_node"));
  CHECK(rec.steps[0].changedTree);
  CHECK_FALSE(rec.steps[0].failed);
  CHECK_EQ(rec.steps[0].note, std::string("create_node"));

  // get_tree first (the read), then the create the model asked for.
  CHECK_EQ(host.calls.size(), 2u);
  CHECK_EQ(host.calls[0].first, std::string("get_tree"));
  CHECK_EQ(host.calls[1].first, std::string("create_node"));

  // The first request carried the translated catalog, the Sonnet model, and the sentence.
  CHECK_EQ(model.requests.size(), 2u);
  CHECK_EQ(model.requests[0]["model"].asString(), std::string("claude-sonnet-5"));
  CHECK_EQ(model.requests[0]["max_tokens"].asInt(), 8000);
  CHECK_EQ(model.requests[0]["tools"], agentTools(host.catalog));
  // System is a cached text block (caches the tool catalog with it), not a bare string.
  CHECK(model.requests[0]["system"][0]["text"].asString().size() > 0);
  CHECK_EQ(model.requests[0]["system"][0]["cache_control"]["type"].asString(), std::string("ephemeral"));
  // The first user turn (prompt + tree) is promoted to a block so the conversation cache breakpoint
  // has somewhere to sit; the sentence is inside that block.
  CHECK(model.requests[0]["messages"][0]["content"][0]["text"].asString().find("add a deploy step") !=
        std::string::npos);
  CHECK_EQ(model.requests[0]["messages"][0]["content"][0]["cache_control"]["type"].asString(),
           std::string("ephemeral"));

  // The second request fed the tool_result back as a user turn keyed to the tool_use id.
  const Json::Value& secondMessages = model.requests[1]["messages"];
  const Json::Value& lastTurn = secondMessages[secondMessages.size() - 1];
  CHECK_EQ(lastTurn["role"].asString(), std::string("user"));
  CHECK_EQ(lastTurn["content"][0]["type"].asString(), std::string("tool_result"));
  CHECK_EQ(lastTurn["content"][0]["tool_use_id"].asString(), std::string("toolu_1"));

  // The conversation cache breakpoint MOVED to the newest turn: the first message no longer
  // carries it, the last one does. This is what keeps the count under the four-per-request cap
  // however long the loop runs — a run that accumulated a marker per turn would 400.
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
  CHECK_EQ(outcome.edits, 0);  // a failed mutation changed nothing
  CHECK_EQ(rec.steps.size(), 1u);
  CHECK(rec.steps[0].failed);
  CHECK_FALSE(rec.steps[0].changedTree);
  CHECK_EQ(rec.steps[0].note, std::string("delete_node failed: node carries progress"));
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
  CHECK_EQ(model.requests.size(), 12u);  // stopped at the cap, not one more
  CHECK_EQ(rec.steps.size(), 12u);
  CHECK_EQ(rec.failures.size(), 1u);
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
  CHECK_EQ(rec.failures.size(), 1u);
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
  CHECK_EQ(model.requests.size(), 0u);  // never reached the model
  CHECK_EQ(rec.failures.size(), 1u);
  CHECK_EQ(rec.failures[0], std::string("agent.setup | could not read the tree before tending"));
}

TEST(anthropic_agent_without_a_key_is_unconfigured_and_never_calls_upstream) {
  AnthropicAgent agent{""};
  CHECK_FALSE(agent.configured());

  FakeToolHost host;
  Recorder rec;
  const AgentOutcome outcome = agent.run("anything", kTree, kCaller, host, rec.onStep());
  CHECK_FALSE(outcome.ok);
  CHECK_EQ(host.calls.size(), 0u);  // no tree read, no model call
}

TEST(anthropic_agent_with_a_key_reports_configured) {
  AnthropicAgent agent{"sk-ant-test"};
  CHECK(agent.configured());
}
