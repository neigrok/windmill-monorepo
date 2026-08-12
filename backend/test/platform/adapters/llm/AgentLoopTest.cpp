#include "platform/adapters/llm/AgentLoop.h"

#include "test/testing.h"

#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm;

namespace {

// A ToolHost the test scripts: a fixed catalog, every call answered through a supplied responder,
// and every call recorded so the loop's traffic is observable.
struct FakeToolHost : ToolHost {
  std::vector<ToolDeclaration> catalog;
  std::vector<std::pair<std::string, Json::Value>> calls;
  std::function<ToolResult(const std::string&, const Json::Value&)> responder;

  std::vector<ToolDeclaration> declareTools() const override { return catalog; }

  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller&) override {
    calls.push_back({name, arguments});
    if (responder) return responder(name, arguments);
    return ToolResult::text("ok");
  }
};

// A scripted model: hands out `replies` one per iteration, then falls back to `whenExhausted` (a
// repeating reply, for the cap) or nullopt (an upstream failure). Every request is recorded.
struct FakeModel {
  std::vector<Json::Value> replies;
  std::optional<Json::Value> whenExhausted;
  std::vector<Json::Value> requests;
  std::size_t index = 0;

  ModelCall asCall() {
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
  schema["properties"] = Json::Value(Json::objectValue);
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

Json::Value userMessage(const char* text) {
  Json::Value message(Json::objectValue);
  message["role"] = "user";
  message["content"] = text;
  Json::Value messages(Json::arrayValue);
  messages.append(message);
  return messages;
}

struct Recorder {
  std::vector<std::string> failures;  // "where | detail", exactly what the operator would see

  AgentReport report() {
    return [this](const std::string& where, const std::string& detail) {
      failures.push_back(where + " | " + detail);
    };
  }
};

AgentLoopSpec spec(const char* question) {
  AgentLoopSpec out;
  out.model = "claude-opus-5";
  out.effort = "medium";
  out.maxIterations = 4;
  out.system = "you are a test";
  out.messages = userMessage(question);
  out.where = "test.run";
  return out;
}

const ToolCaller kCaller{UserId{"u1"}, ToolScope::everything()};

}  // namespace

// --- Translation ----------------------------------------------------------------------------

TEST(the_catalog_renames_inputSchema_to_input_schema_and_keeps_the_rest) {
  Json::Value catalog(Json::arrayValue);
  catalog.append(mcpTool("get_session", "One workout of yours."));
  catalog.append(mcpTool("last_time", "What you did last time."));

  const Json::Value translated = agentToolCatalog(catalog);

  REQUIRE_EQ(translated.size(), 2u);
  CHECK_EQ(translated[0]["name"].asString(), std::string("get_session"));
  CHECK_EQ(translated[0]["description"].asString(), std::string("One workout of yours."));
  CHECK_EQ(translated[0]["input_schema"], catalog[0]["inputSchema"]);
  CHECK_FALSE(translated[0].isMember("inputSchema"));
  CHECK_EQ(translated[1]["name"].asString(), std::string("last_time"));
}

TEST(the_catalog_of_a_non_array_is_empty) {
  CHECK_EQ(agentToolCatalog(Json::Value(Json::nullValue)).size(), 0u);
}

TEST(a_tool_result_carries_the_text_under_the_matching_id) {
  const Json::Value block = agentToolResult("toolu_7", ToolResult::text("done"));
  CHECK_EQ(block["type"].asString(), std::string("tool_result"));
  CHECK_EQ(block["tool_use_id"].asString(), std::string("toolu_7"));
  CHECK_EQ(block["content"].asString(), std::string("done"));
  CHECK_FALSE(block.isMember("is_error"));
}

TEST(a_tool_result_marks_a_failed_tool_so_the_model_sees_it) {
  const Json::Value block = agentToolResult("toolu_9", ToolResult::failure("no such movement"));
  CHECK_EQ(block["content"].asString(), std::string("no such movement"));
  CHECK(block["is_error"].asBool());
}

// --- The loop -------------------------------------------------------------------------------

TEST(the_loop_runs_the_tools_and_answers_on_end_turn) {
  FakeToolHost host;
  host.catalog.push_back(ToolDeclaration{mcpTool("get_stats", "The long view."), "gym", Access::read});
  FakeModel model;
  model.replies.push_back(toolUseReply("get_stats", "toolu_1"));
  model.replies.push_back(textReply("end_turn", "Your squat is moving."));

  Recorder rec;
  const AgentLoopOutcome outcome =
      driveAgentLoop(spec("how is my squat?"), host, kCaller, model.asCall(), rec.report());

  CHECK(outcome.ok);
  CHECK_EQ(outcome.text, std::string("Your squat is moving."));
  CHECK_EQ(outcome.error, std::string(""));
  CHECK_EQ(rec.failures.size(), 0u);

  REQUIRE_EQ(outcome.steps.size(), 1u);
  CHECK_EQ(outcome.steps[0].tool, std::string("get_stats"));
  CHECK_FALSE(outcome.steps[0].failed);

  // The request carried the catalog this caller's grant can see, the model, the bounds — and the
  // system prompt as ONE cached block.
  REQUIRE_EQ(model.requests.size(), 2u);
  CHECK_EQ(model.requests[0]["model"].asString(), std::string("claude-opus-5"));
  CHECK_EQ(model.requests[0]["max_tokens"].asInt(), 8000);
  CHECK_EQ(model.requests[0]["output_config"]["effort"].asString(), std::string("medium"));
  CHECK_EQ(model.requests[0]["tools"], agentToolCatalog(host.listTools(kCaller)));
  CHECK_EQ(model.requests[0]["system"][0]["text"].asString(), std::string("you are a test"));
  CHECK_EQ(model.requests[0]["system"][0]["cache_control"]["type"].asString(),
           std::string("ephemeral"));

  // The second request fed the tool_result back keyed to the tool_use id, and the conversation cache
  // breakpoint MOVED to the newest turn — one marker, however long the loop runs.
  const Json::Value& second = model.requests[1]["messages"];
  const Json::Value& last = second[second.size() - 1];
  CHECK_EQ(last["role"].asString(), std::string("user"));
  CHECK_EQ(last["content"][0]["type"].asString(), std::string("tool_result"));
  CHECK_EQ(last["content"][0]["tool_use_id"].asString(), std::string("toolu_1"));
  int marks = 0;
  for (const Json::Value& message : second)
    for (const Json::Value& block : message["content"])
      if (block.isMember("cache_control")) ++marks;
  CHECK_EQ(marks, 1);
}

// A model without the effort knob is not sent one, rather than being sent a default somebody guessed.
TEST(an_empty_effort_sends_no_output_config_at_all) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("end_turn", "done"));

  AgentLoopSpec quiet = spec("anything");
  quiet.effort.clear();
  Recorder rec;
  driveAgentLoop(quiet, host, kCaller, model.asCall(), rec.report());

  REQUIRE_EQ(model.requests.size(), 1u);
  CHECK_FALSE(model.requests[0].isMember("output_config"));
}

TEST(a_failed_tool_is_a_step_the_loop_keeps_going_from) {
  FakeToolHost host;
  host.responder = [](const std::string&, const Json::Value&) {
    return ToolResult::failure("no such movement");
  };
  FakeModel model;
  model.replies.push_back(toolUseReply("get_stats", "toolu_1"));
  model.replies.push_back(textReply("end_turn", "The log doesn't hold that movement."));

  Recorder rec;
  const AgentLoopOutcome outcome =
      driveAgentLoop(spec("how is my clean?"), host, kCaller, model.asCall(), rec.report());

  CHECK(outcome.ok);
  REQUIRE_EQ(outcome.steps.size(), 1u);
  CHECK(outcome.steps[0].failed);
  CHECK_EQ(outcome.steps[0].tool, std::string("get_stats"));
}

TEST(the_iteration_cap_is_a_failure_and_names_its_own_number) {
  FakeToolHost host;
  FakeModel model;
  model.whenExhausted = toolUseReply("get_stats", "toolu_x");  // never says end_turn

  Recorder rec;
  const AgentLoopOutcome outcome =
      driveAgentLoop(spec("tell me everything"), host, kCaller, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.text, std::string(""));
  CHECK_EQ(outcome.error, std::string("hit the 4-iteration cap without the model finishing"));
  CHECK_EQ(model.requests.size(), 4u);  // stopped at the cap, not one more
  REQUIRE_EQ(rec.failures.size(), 1u);
  CHECK_EQ(rec.failures[0],
           std::string("test.run | hit the 4-iteration cap without the model finishing"));
}

TEST(a_model_that_stopped_early_is_a_failure_and_the_half_answer_is_dropped) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("max_tokens", "You squatted 100 for"));

  Recorder rec;
  const AgentLoopOutcome outcome =
      driveAgentLoop(spec("how did it go?"), host, kCaller, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.text, std::string(""));
  CHECK_EQ(outcome.error, std::string("the model stopped early (stop_reason: max_tokens)"));
  REQUIRE_EQ(rec.failures.size(), 1u);
}

TEST(an_answer_that_said_nothing_is_refused_when_one_was_required) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("end_turn", "   "));

  Recorder rec;
  const AgentLoopOutcome outcome =
      driveAgentLoop(spec("how did it go?"), host, kCaller, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("the model finished without saying anything"));
}

// The other half of that rule: a run whose value is the WORK it did, not the sentence it wrote,
// finishes fine with nothing to say.
TEST(an_empty_final_turn_is_fine_when_no_answer_was_required) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("end_turn", ""));

  AgentLoopSpec silent = spec("do the thing");
  silent.answerRequired = false;
  Recorder rec;
  const AgentLoopOutcome outcome =
      driveAgentLoop(silent, host, kCaller, model.asCall(), rec.report());

  CHECK(outcome.ok);
  CHECK_EQ(outcome.text, std::string(""));
  CHECK_EQ(rec.failures.size(), 0u);
}

TEST(an_unreadable_upstream_reply_ends_the_run) {
  FakeToolHost host;
  FakeModel model;  // no replies, no whenExhausted → nullopt on the first call

  Recorder rec;
  const AgentLoopOutcome outcome =
      driveAgentLoop(spec("how did it go?"), host, kCaller, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("the model call failed or returned an unreadable reply"));
  CHECK_EQ(rec.failures.size(), 1u);
}

TEST(a_reply_missing_its_content_or_stop_reason_ends_the_run) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(Json::Value(Json::objectValue));

  Recorder rec;
  const AgentLoopOutcome outcome =
      driveAgentLoop(spec("how did it go?"), host, kCaller, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("the model reply was missing its content or stop reason"));
}

TEST(a_tool_use_turn_that_named_no_tool_ends_the_run) {
  FakeToolHost host;
  FakeModel model;
  Json::Value empty(Json::objectValue);
  empty["stop_reason"] = "tool_use";
  empty["content"] = Json::Value(Json::arrayValue);
  empty["content"].append(textReply("tool_use", "thinking out loud")["content"][0]);
  model.replies.push_back(empty);

  Recorder rec;
  const AgentLoopOutcome outcome =
      driveAgentLoop(spec("how did it go?"), host, kCaller, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("the model asked for tools but named none"));
  CHECK_EQ(host.calls.size(), 0u);
}

TEST(a_loop_with_no_conversation_touches_nothing) {
  FakeToolHost host;
  FakeModel model;

  AgentLoopSpec bare = spec("unused");
  bare.messages = Json::Value(Json::arrayValue);
  Recorder rec;
  const AgentLoopOutcome outcome = driveAgentLoop(bare, host, kCaller, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(host.calls.size(), 0u);
  CHECK_EQ(model.requests.size(), 0u);
  CHECK_EQ(outcome.error, std::string("the loop was given no conversation to run"));
}
