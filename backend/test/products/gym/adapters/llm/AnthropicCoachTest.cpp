#include "products/gym/adapters/llm/AnthropicCoach.h"

#include "test/testing.h"

#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::gym;

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

  CoachCall asCall() {
    return [this](const Json::Value& request) -> std::optional<Json::Value> {
      requests.push_back(request);
      if (index < replies.size()) return replies[index++];
      return whenExhausted;
    };
  }
};

Json::Value mcpTool(const char* name, const char* description) {
  Json::Value properties(Json::objectValue);
  Json::Value sessionId(Json::objectValue);
  sessionId["type"] = "string";
  properties["sessionId"] = sessionId;

  Json::Value schema(Json::objectValue);
  schema["type"] = "object";
  schema["properties"] = properties;
  schema["additionalProperties"] = false;

  Json::Value tool(Json::objectValue);
  tool["name"] = name;
  tool["description"] = description;
  tool["inputSchema"] = schema;
  return tool;
}

ToolDeclaration declared(const char* name, const char* description, Access access = Access::read) {
  return ToolDeclaration{mcpTool(name, description), "gym", access};
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
  std::vector<std::string> failures;  // "where | detail", exactly what the operator would see

  CoachReporter report() {
    return [this](const std::string& where, const std::string& detail) {
      failures.push_back(where + " | " + detail);
    };
  }
};

const SessionId kSession{"ses_11111111"};
const UserId kLifter{"lifter"};

// The panel's grant, said the same way CoachService says it at its own call site.
ToolCaller readOnly() { return ToolCaller{kLifter, ToolScope({{"gym", Access::read}})}; }

std::vector<CoachTurn> asked(const char* question) { return {CoachTurn{true, question}}; }

}  // namespace

// --- Tool-schema translation ---------------------------------------------------------------

TEST(coach_tools_rename_inputSchema_to_input_schema_and_keep_the_rest) {
  Json::Value catalog(Json::arrayValue);
  catalog.append(mcpTool("get_session", "One workout of yours."));
  catalog.append(mcpTool("last_time", "What you did last time."));

  const Json::Value translated = coachTools(catalog);

  REQUIRE_EQ(translated.size(), 2u);
  CHECK_EQ(translated[0]["name"].asString(), std::string("get_session"));
  CHECK_EQ(translated[0]["description"].asString(), std::string("One workout of yours."));
  CHECK_EQ(translated[0]["input_schema"], catalog[0]["inputSchema"]);
  CHECK_FALSE(translated[0].isMember("inputSchema"));
  CHECK_EQ(translated[1]["name"].asString(), std::string("last_time"));
}

TEST(coach_tools_of_a_non_array_is_empty) {
  CHECK_EQ(coachTools(Json::Value(Json::nullValue)).size(), 0u);
}

TEST(coach_tool_result_carries_the_text_under_the_matching_id) {
  const Json::Value block = coachToolResult("toolu_7", ToolResult::text("done"));
  CHECK_EQ(block["type"].asString(), std::string("tool_result"));
  CHECK_EQ(block["tool_use_id"].asString(), std::string("toolu_7"));
  CHECK_EQ(block["content"].asString(), std::string("done"));
  CHECK_FALSE(block.isMember("is_error"));
}

TEST(coach_tool_result_marks_a_failed_tool_so_the_model_sees_it) {
  const Json::Value block = coachToolResult("toolu_9", ToolResult::failure("no such movement"));
  CHECK_EQ(block["content"].asString(), std::string("no such movement"));
  CHECK(block["is_error"].asBool());
}

// --- The loop -------------------------------------------------------------------------------

TEST(drive_coach_reads_the_workout_first_and_answers_on_end_turn) {
  FakeToolHost host;
  host.catalog.push_back(declared("get_session", "One workout of yours."));
  host.catalog.push_back(declared("last_time", "What you did last time."));
  host.responder = [](const std::string& name, const Json::Value&) {
    if (name == "get_session") return ToolResult::text("{\"session\":\"ses_11111111\"}");
    return ToolResult::text("{\"sets\":[]}");
  };

  FakeModel model;
  model.replies.push_back(toolUseReply("last_time", "toolu_1"));
  model.replies.push_back(textReply("end_turn", "You squatted 100 for five, same as last Tuesday."));

  Recorder rec;
  const CoachAnswer outcome =
      driveCoach(kSession, asked("how did the squats go?"), readOnly(), host, model.asCall(),
                 rec.report());

  CHECK(outcome.ok);
  CHECK_EQ(outcome.answer, std::string("You squatted 100 for five, same as last Tuesday."));
  CHECK_EQ(outcome.error, std::string(""));
  CHECK_EQ(rec.failures.size(), 0u);

  // The workout is read BEFORE the model is asked anything, with its finish readout, pinned to the
  // session the panel was opened on.
  REQUIRE_EQ(host.calls.size(), 2u);
  CHECK_EQ(host.calls[0].first, std::string("get_session"));
  CHECK_EQ(host.calls[0].second["sessionId"].asString(), std::string("ses_11111111"));
  CHECK(host.calls[0].second["review"].asBool());
  CHECK_EQ(host.calls[1].first, std::string("last_time"));

  // One step, and it is the tool the model asked for — not the bootstrap read, which the panel did
  // on the lifter's behalf rather than at the model's request.
  REQUIRE_EQ(outcome.steps.size(), 1u);
  CHECK_EQ(outcome.steps[0].tool, std::string("last_time"));
  CHECK_FALSE(outcome.steps[0].failed);

  // The first request carried the catalog the caller's grant can see, the model, and the workout
  // welded to the lifter's first turn.
  REQUIRE_EQ(model.requests.size(), 2u);
  CHECK_EQ(model.requests[0]["model"].asString(), std::string("claude-opus-5"));
  CHECK_EQ(model.requests[0]["max_tokens"].asInt(), 8000);
  CHECK_EQ(model.requests[0]["output_config"]["effort"].asString(), std::string("medium"));
  CHECK_EQ(model.requests[0]["tools"], coachTools(host.listTools(readOnly())));
  CHECK_EQ(model.requests[0]["system"][0]["cache_control"]["type"].asString(),
           std::string("ephemeral"));
  const std::string firstTurn = model.requests[0]["messages"][0]["content"][0]["text"].asString();
  CHECK(firstTurn.find("how did the squats go?") != std::string::npos);
  CHECK(firstTurn.find("ses_11111111") != std::string::npos);

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

TEST(drive_coach_sends_the_thread_so_far_with_the_roles_the_client_gave_it) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("end_turn", "The second set was the heaviest."));

  Recorder rec;
  const std::vector<CoachTurn> thread{
      CoachTurn{true, "how did the squats go?"},
      CoachTurn{false, "You squatted 100 for five."},
      CoachTurn{true, "which set was heaviest?"},
  };
  const CoachAnswer outcome =
      driveCoach(kSession, thread, readOnly(), host, model.asCall(), rec.report());

  CHECK(outcome.ok);
  REQUIRE_EQ(model.requests.size(), 1u);
  const Json::Value& messages = model.requests[0]["messages"];
  REQUIRE_EQ(messages.size(), 3u);
  CHECK_EQ(messages[0]["role"].asString(), std::string("user"));
  CHECK_EQ(messages[1]["role"].asString(), std::string("assistant"));
  CHECK_EQ(messages[1]["content"].asString(), std::string("You squatted 100 for five."));
  CHECK_EQ(messages[2]["role"].asString(), std::string("user"));
  // Only the FIRST turn carries the workout — the document never moves, which is what makes the
  // growing prefix cacheable across a conversation. It also stays a bare string once it is no longer
  // the newest turn: only the turn holding the cache breakpoint is promoted to a block.
  CHECK(messages[0]["content"].asString().find("get_session returns it") != std::string::npos);
  CHECK(messages[0]["content"].asString().find("how did the squats go?") != std::string::npos);
  // …and the breakpoint is on the newest turn, not the first.
  CHECK(messages[2]["content"][0].isMember("cache_control"));
}

TEST(drive_coach_records_a_failed_tool_as_a_step_and_keeps_going) {
  FakeToolHost host;
  host.catalog.push_back(declared("get_stats", "The long view."));
  host.responder = [](const std::string& name, const Json::Value&) {
    if (name == "get_stats") return ToolResult::failure("no such movement");
    return ToolResult::text("{}");
  };

  FakeModel model;
  model.replies.push_back(toolUseReply("get_stats", "toolu_1"));
  model.replies.push_back(textReply("end_turn", "The log doesn't hold that movement."));

  Recorder rec;
  const CoachAnswer outcome =
      driveCoach(kSession, asked("how is my clean going?"), readOnly(), host, model.asCall(),
                 rec.report());

  CHECK(outcome.ok);
  REQUIRE_EQ(outcome.steps.size(), 1u);
  CHECK(outcome.steps[0].failed);
  CHECK_EQ(outcome.steps[0].tool, std::string("get_stats"));
}

TEST(drive_coach_treats_the_iteration_cap_as_a_failure) {
  FakeToolHost host;
  FakeModel model;
  model.whenExhausted = toolUseReply("get_session", "toolu_x");  // never says end_turn

  Recorder rec;
  const CoachAnswer outcome =
      driveCoach(kSession, asked("tell me everything"), readOnly(), host, model.asCall(),
                 rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.answer, std::string(""));
  CHECK_EQ(outcome.error, std::string("hit the 6-iteration cap without the model finishing"));
  CHECK_EQ(model.requests.size(), 6u);  // stopped at the cap, not one more
  REQUIRE_EQ(rec.failures.size(), 1u);
  CHECK_EQ(rec.failures[0],
           std::string("coach.run | hit the 6-iteration cap without the model finishing"));
}

TEST(drive_coach_fails_and_reports_when_the_model_stops_early) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("max_tokens", "You squatted 100 for"));

  Recorder rec;
  const CoachAnswer outcome =
      driveCoach(kSession, asked("how did it go?"), readOnly(), host, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.answer, std::string(""));  // half an answer about training is a different answer
  CHECK_EQ(outcome.error, std::string("the model stopped early (stop_reason: max_tokens)"));
  REQUIRE_EQ(rec.failures.size(), 1u);
}

TEST(drive_coach_refuses_a_reply_that_said_nothing) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("end_turn", "   "));

  Recorder rec;
  const CoachAnswer outcome =
      driveCoach(kSession, asked("how did it go?"), readOnly(), host, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("the model finished without saying anything"));
}

TEST(drive_coach_fails_on_an_unreadable_upstream_reply) {
  FakeToolHost host;
  FakeModel model;  // no replies, no whenExhausted → nullopt on the first call

  Recorder rec;
  const CoachAnswer outcome =
      driveCoach(kSession, asked("how did it go?"), readOnly(), host, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("the model call failed or returned an unreadable reply"));
  CHECK_EQ(rec.failures.size(), 1u);
}

TEST(drive_coach_never_reaches_the_model_when_the_workout_cannot_be_read) {
  FakeToolHost host;
  host.responder = [](const std::string&, const Json::Value&) {
    return ToolResult::failure("no such session");
  };
  FakeModel model;

  Recorder rec;
  const CoachAnswer outcome =
      driveCoach(kSession, asked("how did it go?"), readOnly(), host, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("could not read the workout before answering"));
  CHECK_EQ(model.requests.size(), 0u);  // no tokens spent on a workout we could not open
  REQUIRE_EQ(rec.failures.size(), 1u);
  CHECK_EQ(rec.failures[0], std::string("coach.setup | could not read the workout before answering"));
}

TEST(drive_coach_refuses_an_empty_thread_without_touching_anything) {
  FakeToolHost host;
  FakeModel model;

  Recorder rec;
  const CoachAnswer outcome =
      driveCoach(kSession, {}, readOnly(), host, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(host.calls.size(), 0u);
  CHECK_EQ(model.requests.size(), 0u);
}

TEST(anthropic_coach_without_a_key_is_unconfigured_and_never_calls_upstream) {
  AnthropicCoach coach{""};
  CHECK_FALSE(coach.configured());

  FakeToolHost host;
  const CoachAnswer outcome = coach.answer(kSession, asked("anything"), readOnly(), host);
  CHECK_FALSE(outcome.ok);
  CHECK_EQ(host.calls.size(), 0u);  // no workout read, no model call
}

TEST(anthropic_coach_with_a_key_reports_configured) {
  AnthropicCoach coach{"sk-ant-test"};
  CHECK(coach.configured());
}
