#include "products/gym/adapters/llm/AnthropicAsk.h"

#include "test/testing.h"

#include <functional>
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

struct FakeModel {
  std::vector<Json::Value> replies;
  std::optional<Json::Value> whenExhausted;
  std::vector<Json::Value> requests;
  std::size_t index = 0;

  AskCall asCall() {
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

  AgentReport report() {
    return [this](const std::string& where, const std::string& detail) {
      failures.push_back(where + " | " + detail);
    };
  }
};

const UserId kLifter{"lifter"};

// Ask's grant, said the same way AskService says it at its own call site: the levels that let the
// reads and the two proposal mints through the catalog filter, and nothing wider.
ToolCaller asked() {
  return ToolCaller{kLifter, ToolScope({{"gym", Access::read},
                                        {"gym", Access::write},
                                        {"gym", Access::del}})};
}

std::vector<AskTurn> question(const char* text) { return {AskTurn{true, text}}; }

}  // namespace

TEST(ask_reads_the_log_first_and_answers_on_end_turn) {
  FakeToolHost host;
  host.catalog.push_back(declared("list_sessions", "Your training log."));
  host.catalog.push_back(declared("get_stats", "The long view."));
  host.responder = [](const std::string& name, const Json::Value&) {
    if (name == "list_sessions") return ToolResult::text("{\"sessions\":[],\"read\":{\"sets\":0}}");
    return ToolResult::text("{\"weeks\":[]}");
  };

  FakeModel model;
  model.replies.push_back(toolUseReply("get_stats", "toolu_1"));
  model.replies.push_back(textReply("end_turn", "Bench has held at 82.5 for three weeks."));

  Recorder rec;
  const AskAnswer outcome =
      driveAsk(question("what's happening with my bench?"), asked(), host, model.asCall(),
               rec.report());

  CHECK(outcome.ok);
  CHECK_EQ(outcome.answer, std::string("Bench has held at 82.5 for three weeks."));
  CHECK_EQ(outcome.error, std::string(""));
  CHECK_EQ(rec.failures.size(), 0u);

  // THE LOG, not one workout: the opening read is the newest page and it happens before the model is
  // asked anything. W7's whole widening is this line.
  REQUIRE_EQ(host.calls.size(), 2u);
  CHECK_EQ(host.calls[0].first, std::string("list_sessions"));
  CHECK_EQ(host.calls[0].second, Json::Value(Json::objectValue));  // the default page, no arguments
  CHECK_EQ(host.calls[1].first, std::string("get_stats"));

  // One step, and it is the tool the model asked for — not the opening read, which Ask made on the
  // lifter's behalf rather than at the model's request.
  REQUIRE_EQ(outcome.steps.size(), 1u);
  CHECK_EQ(outcome.steps[0].tool, std::string("get_stats"));
  CHECK_FALSE(outcome.steps[0].failed);

  // The first request carried the catalog the caller's grant can see, the model, the cap's room, and
  // the log welded to the lifter's first turn.
  REQUIRE_EQ(model.requests.size(), 2u);
  CHECK_EQ(model.requests[0]["model"].asString(), std::string("claude-opus-5"));
  CHECK_EQ(model.requests[0]["max_tokens"].asInt(), 8000);
  CHECK_EQ(model.requests[0]["output_config"]["effort"].asString(), std::string("medium"));
  CHECK_EQ(model.requests[0]["tools"], agentToolCatalog(host.listTools(asked())));
  CHECK_EQ(model.requests[0]["system"][0]["cache_control"]["type"].asString(),
           std::string("ephemeral"));
  const std::string firstTurn = model.requests[0]["messages"][0]["content"][0]["text"].asString();
  CHECK(firstTurn.find("what's happening with my bench?") != std::string::npos);
  CHECK(firstTurn.find("list_sessions returns it") != std::string::npos);
}

// The word the brief bans, checked where it would actually be read: the system prompt is the one
// place gym still writes prose for a model, and a prompt that called Ask a coach would put the word
// straight back into the answers a lifter reads.
TEST(nothing_ask_sends_the_model_calls_it_a_coach) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("end_turn", "fine"));

  Recorder rec;
  driveAsk(question("anything"), asked(), host, model.asCall(), rec.report());

  REQUIRE_EQ(model.requests.size(), 1u);
  const std::string prompt = model.requests[0]["system"][0]["text"].asString();
  CHECK(prompt.find("coach") == std::string::npos);
  CHECK(prompt.find("Coach") == std::string::npos);
  // …and it says the two things §L's ladder turns on.
  CHECK(prompt.find("propose_routine_change") != std::string::npos);
  CHECK(prompt.find("CHANGE NOTHING") != std::string::npos);
}

TEST(ask_sends_the_thread_so_far_with_the_roles_the_client_gave_it) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("end_turn", "The second set was the heaviest."));

  Recorder rec;
  const std::vector<AskTurn> thread{
      AskTurn{true, "how did the squats go?"},
      AskTurn{false, "You squatted 100 for five."},
      AskTurn{true, "which set was heaviest?"},
  };
  const AskAnswer outcome = driveAsk(thread, asked(), host, model.asCall(), rec.report());

  CHECK(outcome.ok);
  REQUIRE_EQ(model.requests.size(), 1u);
  const Json::Value& messages = model.requests[0]["messages"];
  REQUIRE_EQ(messages.size(), 3u);
  CHECK_EQ(messages[0]["role"].asString(), std::string("user"));
  CHECK_EQ(messages[1]["role"].asString(), std::string("assistant"));
  CHECK_EQ(messages[1]["content"].asString(), std::string("You squatted 100 for five."));
  CHECK_EQ(messages[2]["role"].asString(), std::string("user"));
  // Only the FIRST turn carries the log — the document never moves, which is what makes the growing
  // prefix cacheable across a conversation. It also stays a bare string once it is no longer the
  // newest turn: only the turn holding the cache breakpoint is promoted to a block.
  CHECK(messages[0]["content"].asString().find("list_sessions returns it") != std::string::npos);
  CHECK(messages[2]["content"][0].isMember("cache_control"));
}

TEST(ask_never_reaches_the_model_when_the_log_cannot_be_read) {
  FakeToolHost host;
  host.responder = [](const std::string&, const Json::Value&) {
    return ToolResult::failure("no log");
  };
  FakeModel model;

  Recorder rec;
  const AskAnswer outcome =
      driveAsk(question("how did it go?"), asked(), host, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("could not read the log before answering"));
  CHECK_EQ(model.requests.size(), 0u);  // no tokens spent on a log we could not open
  REQUIRE_EQ(rec.failures.size(), 1u);
  CHECK_EQ(rec.failures[0], std::string("ask.setup | could not read the log before answering"));
}

TEST(ask_refuses_an_empty_thread_without_touching_anything) {
  FakeToolHost host;
  FakeModel model;

  Recorder rec;
  const AskAnswer outcome = driveAsk({}, asked(), host, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(host.calls.size(), 0u);
  CHECK_EQ(model.requests.size(), 0u);
}

// The cap is wider than the panel's six because the reach is wider — and hitting it is still a
// failure, printed to nobody.
TEST(ask_treats_the_eight_iteration_cap_as_a_failure) {
  FakeToolHost host;
  FakeModel model;
  model.whenExhausted = toolUseReply("get_stats", "toolu_x");  // never says end_turn

  Recorder rec;
  const AskAnswer outcome =
      driveAsk(question("tell me everything"), asked(), host, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.answer, std::string(""));
  CHECK_EQ(outcome.error, std::string("hit the 8-iteration cap without the model finishing"));
  CHECK_EQ(model.requests.size(), 8u);
  REQUIRE_EQ(rec.failures.size(), 1u);
  CHECK_EQ(rec.failures[0],
           std::string("ask.run | hit the 8-iteration cap without the model finishing"));
}

TEST(ask_fails_and_reports_when_the_model_stops_early) {
  FakeToolHost host;
  FakeModel model;
  model.replies.push_back(textReply("max_tokens", "You squatted 100 for"));

  Recorder rec;
  const AskAnswer outcome =
      driveAsk(question("how did it go?"), asked(), host, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.answer, std::string(""));  // half an answer about training is a different answer
  CHECK_EQ(outcome.error, std::string("the model stopped early (stop_reason: max_tokens)"));
  REQUIRE_EQ(rec.failures.size(), 1u);
}

TEST(ask_fails_on_an_unreadable_upstream_reply) {
  FakeToolHost host;
  FakeModel model;  // no replies, no whenExhausted → nullopt on the first call

  Recorder rec;
  const AskAnswer outcome =
      driveAsk(question("how did it go?"), asked(), host, model.asCall(), rec.report());

  CHECK_FALSE(outcome.ok);
  CHECK_EQ(outcome.error, std::string("the model call failed or returned an unreadable reply"));
  CHECK_EQ(rec.failures.size(), 1u);
}

TEST(anthropic_ask_without_a_key_is_unconfigured_and_never_calls_upstream) {
  AnthropicAsk ask{""};
  CHECK_FALSE(ask.configured());

  FakeToolHost host;
  const AskAnswer outcome = ask.answer(question("anything"), asked(), host);
  CHECK_FALSE(outcome.ok);
  CHECK_EQ(host.calls.size(), 0u);  // no log read, no model call
}

TEST(anthropic_ask_with_a_key_reports_configured) {
  AnthropicAsk ask{"sk-ant-test"};
  CHECK(ask.configured());
}
