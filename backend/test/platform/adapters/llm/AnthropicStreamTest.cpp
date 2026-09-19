#include "platform/adapters/llm/AnthropicStream.h"
#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

using namespace wm;

namespace {
std::string events(std::initializer_list<std::string> values) {
  std::string body;
  for (const auto& value : values) body += "event: vendor\r\ndata: " + value + "\r\n\r\n";
  return body;
}
}

TEST(anthropic_stream_arbitrary_byte_boundaries_preserve_text_tools_thinking_and_usage) {
  const auto body = events({
    R"({"type":"message_start","message":{"id":"msg1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":13,"output_tokens":1,"cache_read_input_tokens":7}}})",
    R"({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}})",
    R"({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private"}})",
    R"({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}})",
    R"({"type":"content_block_stop","index":0})",
    R"({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}})",
    R"({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Héllo 🏋️"}})",
    R"({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" lifter"}})",
    R"({"type":"content_block_stop","index":1})",
    R"({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool1","name":"create_routine","input":{}}})",
    R"({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"name\":"}})",
    R"({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"Upper\"}"}})",
    R"({"type":"content_block_stop","index":2})",
    R"({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":19}})",
    R"({"type":"message_stop"})"});
  for (std::size_t size = 1; size <= 31; ++size) {
    std::vector<std::string> text;
    AnthropicMessageStream parser{[&](const auto& value) { text.push_back(value); }};
    for (std::size_t position = 0; position < body.size(); position += size)
      REQUIRE(parser.feed(std::string_view(body).substr(position, std::min(size, body.size() - position))));
    REQUIRE(parser.complete());
    const auto message = parser.finish();
    REQUIRE(message.has_value());
    CHECK_EQ(*message, parse(R"({"id":"msg1","type":"message","role":"assistant","stop_reason":"tool_use","content":[{"type":"thinking","thinking":"private","signature":"signed"},{"type":"text","text":"Héllo 🏋️ lifter"},{"type":"tool_use","id":"tool1","name":"create_routine","input":{"name":"Upper"}}],"usage":{"input_tokens":13,"output_tokens":19,"cache_read_input_tokens":7}})"));
    CHECK_EQ(text, (std::vector<std::string>{"Héllo 🏋️", "Héllo 🏋️ lifter"}));
  }
}

TEST(anthropic_stream_requires_message_stop_and_preserves_partial_usage_on_failure_or_cancel) {
  const auto prefix = events({
    R"({"type":"message_start","message":{"content":[],"usage":{"input_tokens":13,"output_tokens":1}}})",
    R"({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})",
    R"({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Half an answer"}})",
    R"({"type":"content_block_stop","index":0})",
    R"({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}})"});
  for (const auto& tail : {std::string{}, events({R"({"type":"error","error":{"type":"overloaded_error"}})"}), std::string("data: {broken}\n\n")}) {
    AnthropicMessageStream parser;
    REQUIRE(parser.feed(prefix));
    if (!tail.empty()) CHECK_FALSE(parser.feed(tail));
    CHECK_FALSE(parser.complete());
    const auto message = parser.finish();
    REQUIRE(message.has_value());
    CHECK_EQ(*message, parse(R"({"content":[{"type":"text","text":"Half an answer"}],"usage":{"input_tokens":13,"output_tokens":9},"stop_reason":"transport_error"})"));
  }
  struct Ledger : UsageSink {
    std::vector<AiSpend> rows;
    void record(const AiSpend& row) noexcept override { rows.push_back(row); }
  };
  const auto ledger = std::make_shared<Ledger>();
  AiSpend frame;
  frame.model = "claude-opus-5";
  frame.product = "gym";
  const auto call = metered([&](const Json::Value&) {
    AnthropicMessageStream parser;
    parser.feed(prefix);
    return parser.finish("cancelled");
  }, frame, nullptr, ledger, [](const auto&, const auto&) {});
  const auto cancelled = call(Json::Value{});
  REQUIRE(cancelled.has_value());
  CHECK_EQ((*cancelled)["stop_reason"].asString(), std::string("cancelled"));
  REQUIRE_EQ(ledger->rows.size(), 1u);
  const auto tokens = ledger->rows.front().tokens;
  CHECK_EQ(tokens.input, 13);
  CHECK_EQ(tokens.output, 9);
  CHECK_EQ(tokens.cacheRead, 0);
  CHECK_EQ(tokens.cacheWrite, 0);
}

TEST(anthropic_stream_rejects_unclosed_tool_json_malformed_events_and_resource_overruns) {
  AnthropicMessageStream unfinished;
  REQUIRE(unfinished.feed(events({R"({"type":"message_start","message":{"content":[]}})",
      R"({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool1","name":"write","input":{}}})",
      R"({"type":"message_delta","delta":{"stop_reason":"tool_use"}})"})));
  CHECK_FALSE(unfinished.feed(events({R"({"type":"message_stop"})"})));
  CHECK_EQ((*unfinished.finish())["stop_reason"].asString(), std::string("transport_error"));
  AnthropicMessageStream malformed;
  CHECK_FALSE(malformed.feed("data: []\n\n"));
  CHECK_FALSE(malformed.finish().has_value());
  AnthropicMessageStream oversized;
  CHECK_FALSE(oversized.feed(std::string(256 * 1024 + 1, 'x')));
  AnthropicMessageStream endless;
  const std::string ping = events({R"({"type":"ping"})"});
  bool allowed = true;
  for (std::size_t bytes = 0; allowed && bytes <= 4 * 1024 * 1024; bytes += ping.size()) allowed = endless.feed(ping);
  CHECK_FALSE(allowed);
  AnthropicMessageStream completed;
  REQUIRE(completed.feed(events({R"({"type":"message_start","message":{"content":[]}})",
      R"({"type":"message_delta","delta":{"stop_reason":"end_turn"}})", R"({"type":"message_stop"})"})));
  CHECK(completed.complete());
  CHECK_FALSE(completed.feed(std::string(4 * 1024 * 1024, 'x')));
  CHECK_EQ((*completed.finish())["stop_reason"].asString(), std::string("transport_error"));
}

TEST(anthropic_stream_ignores_unknown_events_before_and_after_message_start) {
  AnthropicMessageStream parser;
  REQUIRE(parser.feed(events({R"({"type":"future_event","private":"not diagnostic content"})",
      R"({"type":"message_start","message":{"content":[],"usage":{"input_tokens":2}}})",
      R"({"type":"future_event","private":"not diagnostic content"})",
      R"({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}})",
      R"({"type":"message_stop"})"})));
  CHECK_EQ(*parser.finish(), parse(R"({"content":[],"usage":{"input_tokens":2,"output_tokens":3},"stop_reason":"end_turn"})"));
  CHECK_EQ(parser.diagnostic(200, 0), parse(R"({"httpStatus":200,"curlCode":0,"messageStarted":true,"messageComplete":true,"cancelled":false,"callbackFailed":false,"parserFailure":"none","providerError":"none"})"));
}

TEST(anthropic_stream_diagnostics_distinguish_pre_start_provider_errors_http_errors_and_invalid_events) {
  AnthropicMessageStream overloaded;
  CHECK_FALSE(overloaded.feed(events({R"({"type":"error","error":{"type":"overloaded_error","message":"PRIVATE provider detail"},"request_id":"PRIVATE request"})"})));
  CHECK_FALSE(overloaded.finish().has_value());
  CHECK_EQ(overloaded.diagnostic(200, 23), parse(R"({"httpStatus":200,"curlCode":23,"messageStarted":false,"messageComplete":false,"cancelled":false,"callbackFailed":false,"parserFailure":"provider_error","providerError":"overloaded_error"})"));

  AnthropicMessageStream rejected;
  REQUIRE(rejected.feed("{\n\"type\":\"error\",\n\"error\":{\"type\":\"rate_limit_error\",\"message\":\"PRIVATE key and prompt\"}}"));
  CHECK_FALSE(rejected.finish().has_value());
  CHECK_EQ(rejected.diagnostic(429, 0), parse(R"({"httpStatus":429,"curlCode":0,"messageStarted":false,"messageComplete":false,"cancelled":false,"callbackFailed":false,"parserFailure":"missing_message_start","providerError":"rate_limit_error"})"));

  AnthropicMessageStream invalidJson;
  CHECK_FALSE(invalidJson.feed("data: {PRIVATE malformed body}\n\n"));
  CHECK_EQ(invalidJson.diagnostic(200, 23), parse(R"({"httpStatus":200,"curlCode":23,"messageStarted":false,"messageComplete":false,"cancelled":false,"callbackFailed":false,"parserFailure":"invalid_json","providerError":"none"})"));

  AnthropicMessageStream invalidEvent;
  CHECK_FALSE(invalidEvent.feed(events({R"({"type":"message_start","message":"PRIVATE wrong shape"})"})));
  CHECK_EQ(invalidEvent.diagnostic(200, 23), parse(R"({"httpStatus":200,"curlCode":23,"messageStarted":false,"messageComplete":false,"cancelled":false,"callbackFailed":false,"parserFailure":"invalid_event","providerError":"none"})"));
}

TEST(anthropic_stream_diagnostics_never_copy_unknown_error_types_or_private_content) {
  for (const auto& body : {
      R"({"type":"error","error":{"type":"PRIVATE unknown error type","message":"PRIVATE response"}})",
      R"({"type":"error","error":{"type":{"PRIVATE":"malformed type"},"message":"PRIVATE response"}})"}) {
    AnthropicMessageStream parser;
    CHECK_FALSE(parser.feed(events({body})));
    CHECK_EQ(parser.diagnostic(200, 23), parse(R"({"httpStatus":200,"curlCode":23,"messageStarted":false,"messageComplete":false,"cancelled":false,"callbackFailed":false,"parserFailure":"provider_error","providerError":"unknown"})"));
  }
  AnthropicMessageStream interrupted;
  REQUIRE(interrupted.feed(events({R"({"type":"message_start","message":{"content":[],"usage":{"input_tokens":2}}})"})));
  CHECK_EQ(interrupted.diagnostic(200, 42, true), parse(R"({"httpStatus":200,"curlCode":42,"messageStarted":true,"messageComplete":false,"cancelled":true,"callbackFailed":false,"parserFailure":"missing_message_stop","providerError":"none"})"));
  AnthropicMessageStream empty;
  CHECK_EQ(empty.diagnostic(0, 7), parse(R"({"httpStatus":0,"curlCode":7,"messageStarted":false,"messageComplete":false,"cancelled":false,"callbackFailed":false,"parserFailure":"missing_message_start","providerError":"none"})"));
}
