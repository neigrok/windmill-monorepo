#include "products/roadmap/adapters/llm/AnthropicComposer.h"

#include "test/testing.h"

#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

using namespace wm;

namespace {

struct ParsedStream {
  std::vector<std::string> deltas;
  int doneCalls = 0;
  bool ok = false;
  std::vector<std::string> failures;  // what the operator would have been told
  AnthropicStreamParser parser{
      [this](const std::string& delta) { deltas.push_back(delta); },
      [this](bool clean) { ++doneCalls; ok = clean; },
      [this](const std::string& where, const std::string& detail) {
        failures.push_back(where + " | " + detail);
      }};

  void feedBytewise(const std::string& wire) {
    for (const char c : wire) parser.feed(&c, 1);
  }
};

std::string chunk(const std::string& data) {
  std::ostringstream out;
  out << std::hex << data.size() << "\r\n" << data << "\r\n";
  return out.str();
}

std::string sse(const std::string& event, const std::string& data) {
  return "event: " + event + "\ndata: " + data + "\n\n";
}

constexpr const char* kStreamHeaders =
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: text/event-stream; charset=utf-8\r\n"
    "Transfer-Encoding: chunked\r\n"
    "\r\n";

}

TEST(stripped_plan_leaves_a_clean_plan_untouched) {
  const std::string plan = "# Learn to sail\n\n## Basics\n- [x] Read the theory\n1. Rig the boat";
  CHECK_EQ(strippedPlan(plan), plan);
}

TEST(stripped_plan_trims_surrounding_whitespace) {
  CHECK_EQ(strippedPlan("\n\n# Plan\n- Step one\n\n  "), std::string("# Plan\n- Step one"));
}

TEST(stripped_plan_removes_a_wrapping_code_fence) {
  CHECK_EQ(strippedPlan("```\n# Plan\n- Step one\n```"), std::string("# Plan\n- Step one"));
  CHECK_EQ(strippedPlan("```markdown\n# Plan\n- Step one\n```\n"), std::string("# Plan\n- Step one"));
}

TEST(stripped_plan_removes_a_lone_leading_or_trailing_fence) {
  CHECK_EQ(strippedPlan("```markdown\n# Plan\n- Step one"), std::string("# Plan\n- Step one"));
  CHECK_EQ(strippedPlan("# Plan\n- Step one\n```"), std::string("# Plan\n- Step one"));
}

TEST(stripped_plan_keeps_backticks_that_are_not_fence_lines) {
  CHECK_EQ(strippedPlan("# Plan\n- Run `make ```weird``` target`"),
           std::string("# Plan\n- Run `make ```weird``` target`"));
}

TEST(stripped_plan_of_a_fence_only_reply_is_empty) {
  CHECK_EQ(strippedPlan("```"), std::string(""));
  CHECK_EQ(strippedPlan("```markdown\n```"), std::string(""));
  CHECK_EQ(strippedPlan("   \n\t"), std::string(""));
}

TEST(anthropic_composer_without_a_key_is_unconfigured_and_never_calls_upstream) {
  AnthropicComposer composer{""};
  CHECK_FALSE(composer.configured());
  std::optional<std::string> result = std::string("untouched");
  composer.compose("anything", [&](std::optional<std::string> plan) { result = std::move(plan); });
  CHECK(result == std::nullopt);
}

TEST(anthropic_composer_with_a_key_reports_configured) {
  AnthropicComposer composer{"sk-ant-test"};
  CHECK(composer.configured());
}

TEST(anthropic_composer_stream_without_a_key_fails_without_calling_upstream) {
  AnthropicComposer composer{""};
  ParsedStream observed;
  composer.composeStream(
      "anything", [&](const std::string& delta) { observed.deltas.push_back(delta); },
      [&](bool clean) { ++observed.doneCalls; observed.ok = clean; });
  CHECK_EQ(observed.doneCalls, 1);
  CHECK_FALSE(observed.ok);
  CHECK_EQ(observed.deltas.size(), 0u);
}

TEST(stream_parser_forwards_text_deltas_and_finishes_clean_on_end_turn) {
  ParsedStream observed;
  const std::string wire =
      std::string(kStreamHeaders) +
      chunk(sse("message_start", R"({"type":"message_start","message":{"id":"msg_1"}})")) +
      chunk(sse("content_block_start",
                R"({"type":"content_block_start","index":0,"content_block":{"type":"thinking"}})")) +
      chunk(sse("content_block_delta",
                R"({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}})")) +
      chunk(sse("content_block_delta",
                R"({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"# Learn to sail\n"}})")) +
      chunk(": keepalive\n\n") +
      chunk(sse("content_block_delta",
                R"({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"- Rig the boat"}})")) +
      chunk(sse("message_delta", R"({"type":"message_delta","delta":{"stop_reason":"end_turn"}})")) +
      chunk(sse("message_stop", R"({"type":"message_stop"})")) +
      "0\r\n\r\n";

  observed.feedBytewise(wire);  // one byte at a time: every split point is exercised

  REQUIRE_EQ(observed.deltas.size(), 2u);
  CHECK_EQ(observed.deltas[0], std::string("# Learn to sail\n"));
  CHECK_EQ(observed.deltas[1], std::string("- Rig the boat"));
  CHECK_EQ(observed.doneCalls, 1);
  CHECK(observed.ok);
  CHECK(observed.parser.done());
}

TEST(stream_parser_fails_on_a_truncating_stop_reason_after_the_deltas) {
  ParsedStream observed;
  observed.feedBytewise(
      std::string(kStreamHeaders) +
      chunk(sse("content_block_delta",
                R"({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"# Half a"}})")) +
      chunk(sse("message_delta", R"({"type":"message_delta","delta":{"stop_reason":"max_tokens"}})")) +
      chunk(sse("message_stop", R"({"type":"message_stop"})")));

  REQUIRE_EQ(observed.deltas.size(), 1u);
  CHECK_EQ(observed.deltas[0], std::string("# Half a"));
  CHECK_EQ(observed.doneCalls, 1);
  CHECK_FALSE(observed.ok);
}

TEST(stream_parser_fails_on_a_non_200_status) {
  ParsedStream observed;
  observed.feedBytewise("HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\n\r\n");

  CHECK_EQ(observed.doneCalls, 1);
  CHECK_FALSE(observed.ok);
  CHECK_EQ(observed.deltas.size(), 0u);

  observed.parser.finish();  // the close that follows must not double-report
  CHECK_EQ(observed.doneCalls, 1);
}

TEST(stream_parser_fails_on_an_upstream_error_event) {
  ParsedStream observed;
  observed.feedBytewise(
      std::string(kStreamHeaders) +
      chunk(sse("error", R"({"type":"error","error":{"type":"overloaded_error"}})")));

  CHECK_EQ(observed.doneCalls, 1);
  CHECK_FALSE(observed.ok);
}

TEST(stream_parser_fails_when_the_connection_closes_before_message_stop) {
  ParsedStream observed;
  observed.feedBytewise(
      std::string(kStreamHeaders) +
      chunk(sse("content_block_delta",
                R"({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"# Learn"}})")));
  CHECK_EQ(observed.doneCalls, 0);

  observed.parser.finish();

  REQUIRE_EQ(observed.deltas.size(), 1u);
  CHECK_EQ(observed.deltas[0], std::string("# Learn"));
  CHECK_EQ(observed.doneCalls, 1);
  CHECK_FALSE(observed.ok);
}

TEST(stream_parser_handles_a_plain_unchunked_body_too) {
  ParsedStream observed;
  observed.feedBytewise(
      "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n" +
      sse("content_block_delta",
          R"({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"# Plan"}})") +
      sse("message_delta", R"({"type":"message_delta","delta":{"stop_reason":"end_turn"}})") +
      sse("message_stop", R"({"type":"message_stop"})"));

  REQUIRE_EQ(observed.deltas.size(), 1u);
  CHECK_EQ(observed.deltas[0], std::string("# Plan"));
  CHECK_EQ(observed.doneCalls, 1);
  CHECK(observed.ok);
}

// The failure that started this: a plan cut off by the token budget refuses cleanly, and used to
// refuse in total silence — the client saw an open stream say nothing and nothing anywhere went red.
TEST(stream_parser_names_a_truncated_plan_to_the_operator) {
  ParsedStream observed;
  observed.feedBytewise(
      std::string(kStreamHeaders) +
      chunk(sse("content_block_delta", R"({"delta":{"type":"text_delta","text":"# Plan"}})")) +
      chunk(sse("message_delta", R"({"delta":{"stop_reason":"max_tokens"}})")) +
      chunk(sse("message_stop", "{}")));

  CHECK_EQ(observed.doneCalls, 1);
  CHECK_FALSE(observed.ok);
  REQUIRE_EQ(observed.failures.size(), 1u);
  CHECK_EQ(observed.failures[0], std::string("compose.stream | stopped early (stop_reason: max_tokens)"));
}

TEST(stream_parser_names_an_upstream_error_to_the_operator) {
  ParsedStream observed;
  observed.feedBytewise(
      std::string(kStreamHeaders) +
      chunk(sse("error", R"({"type":"error","error":{"type":"overloaded_error"}})")));

  REQUIRE_EQ(observed.failures.size(), 1u);
  CHECK(observed.failures[0].find("compose.stream | upstream error event:") == 0);
  CHECK(observed.failures[0].find("overloaded_error") != std::string::npos);
}

TEST(stream_parser_stays_quiet_when_the_plan_finishes_cleanly) {
  ParsedStream observed;
  observed.feedBytewise(
      std::string(kStreamHeaders) +
      chunk(sse("content_block_delta", R"({"delta":{"type":"text_delta","text":"# Plan"}})")) +
      chunk(sse("message_delta", R"({"delta":{"stop_reason":"end_turn"}})")) +
      chunk(sse("message_stop", "{}")));

  CHECK(observed.ok);
  CHECK_EQ(observed.failures.size(), 0u);
}

// --- The meter ------------------------------------------------------------------------------

// The two frames the decoder never used to read, and between them they are the entire bill for a
// streamed compose. message_start is the only frame carrying the input count and both cache
// counters; message_delta carries the output count, as a SIBLING of `delta` and as a RUNNING TOTAL.
TEST(stream_parser_counts_the_input_from_message_start_and_the_output_from_message_delta) {
  ParsedStream observed;
  observed.feedBytewise(
      std::string(kStreamHeaders) +
      chunk(sse("message_start",
                R"({"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":812,"output_tokens":1,"cache_read_input_tokens":9100,"cache_creation_input_tokens":240}}})")) +
      chunk(sse("content_block_delta",
                R"({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"# Plan"}})")) +
      chunk(sse("message_delta",
                R"({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":964}})")) +
      chunk(sse("message_stop", "{}")));

  CHECK(observed.ok);
  const TokenUse tokens = observed.parser.tokens();
  CHECK_EQ(tokens.input, 812LL);
  CHECK_EQ(tokens.cacheRead, 9100LL);
  CHECK_EQ(tokens.cacheWrite, 240LL);
  // The running total, ASSIGNED. The 1 that message_start declared is replaced, not added to — a
  // += here would have billed 965 for a 964-token plan, and worse on every extra frame.
  CHECK_EQ(tokens.output, 964LL);
}

TEST(stream_parser_takes_the_last_running_output_total_rather_than_summing_them) {
  ParsedStream observed;
  observed.feedBytewise(
      std::string(kStreamHeaders) +
      chunk(sse("message_start",
                R"({"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}})")) +
      chunk(sse("message_delta", R"({"type":"message_delta","delta":{},"usage":{"output_tokens":40}})")) +
      chunk(sse("message_delta",
                R"({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":90}})")) +
      chunk(sse("message_stop", "{}")));

  CHECK_EQ(observed.parser.tokens().output, 90LL);   // not 1 + 40 + 90
  CHECK_EQ(observed.parser.tokens().input, 100LL);
}

// A plan the budget cut off still cost every token it spent getting there, and it is the reply the
// product throws away — exactly the shape a success-only meter would price at nothing.
TEST(stream_parser_counts_a_truncated_stream_too) {
  ParsedStream observed;
  observed.feedBytewise(
      std::string(kStreamHeaders) +
      chunk(sse("message_start",
                R"({"type":"message_start","message":{"usage":{"input_tokens":24000,"output_tokens":1}}})")) +
      chunk(sse("message_delta",
                R"({"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":8000}})")) +
      chunk(sse("message_stop", "{}")));

  CHECK_FALSE(observed.ok);
  CHECK_EQ(observed.parser.tokens().input, 24000LL);
  CHECK_EQ(observed.parser.tokens().output, 8000LL);
}

TEST(stream_parser_survives_a_message_start_it_cannot_read) {
  ParsedStream observed;
  observed.feedBytewise(
      std::string(kStreamHeaders) + chunk(sse("message_start", "{not json")) +
      chunk(sse("content_block_delta", R"({"delta":{"type":"text_delta","text":"# Plan"}})")) +
      chunk(sse("message_delta", R"({"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}})")) +
      chunk(sse("message_stop", "{}")));

  // A frame we cannot read costs a token count, never the plan: the reader still got their tree.
  CHECK(observed.ok);
  REQUIRE_EQ(observed.deltas.size(), 1u);
  CHECK_EQ(observed.parser.tokens().input, 0LL);
  CHECK_EQ(observed.parser.tokens().output, 12LL);
}

// --- The gates in front of the vendor --------------------------------------------------------

TEST(composer_refuses_an_oversized_paste_without_calling_upstream) {
  AnthropicComposer composer{"sk-ant-test"};
  const std::string book(30000, 'x');   // well past the ~24k cap a birth canvas ever needs

  std::optional<std::string> result = std::string("untouched");
  composer.compose(book, [&](std::optional<std::string> plan) { result = std::move(plan); });
  // Answered synchronously, which is only possible if no socket was opened. The caller's fallback
  // is the deterministic parser, so the door still works — it is merely less clever.
  CHECK(result == std::nullopt);

  ParsedStream observed;
  composer.composeStream(book, [&](const std::string& delta) { observed.deltas.push_back(delta); },
                         [&](bool clean) { ++observed.doneCalls; observed.ok = clean; });
  CHECK_EQ(observed.doneCalls, 1);
  CHECK_FALSE(observed.ok);
}

TEST(composer_over_the_fuse_refuses_without_calling_upstream) {
  auto fuse = std::make_shared<AiFuse>(1'000);
  fuse->spent(2'000, nowMs());
  AnthropicComposer composer{"sk-ant-test", nullptr, fuse};

  std::optional<std::string> result = std::string("untouched");
  composer.compose("a paragraph of notes", [&](std::optional<std::string> plan) { result = std::move(plan); });
  CHECK(result == std::nullopt);

  ParsedStream observed;
  composer.composeStream("a paragraph of notes",
                         [&](const std::string& delta) { observed.deltas.push_back(delta); },
                         [&](bool clean) { ++observed.doneCalls; observed.ok = clean; });
  CHECK_EQ(observed.doneCalls, 1);
  CHECK_FALSE(observed.ok);
  CHECK_EQ(observed.deltas.size(), 0u);
}
