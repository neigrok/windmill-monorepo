#include "products/journal/adapters/llm/AnthropicCurator.h"

#include "test/testing.h"

#include <json/json.h>

#include <memory>
#include <string>
#include <vector>

using namespace wm;

namespace {

// The transport, faked; its bytes go through the real reader, so every failure word below is the one the live edge would produce.
struct FakeMessages : MessagesApi {
  bool ready = true;
  MessagesReply reply;
  std::vector<MessagesRequest> sent;

  bool configured() const override { return ready; }

  MessagesReply send(const MessagesRequest& request) override {
    sent.push_back(request);
    return reply;
  }
};

std::string write(const Json::Value& value) {
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, value);
}

Json::Value parse(const std::string& text) {
  Json::Value value;
  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  std::string errors;
  reader->parse(text.data(), text.data() + text.size(), &value, &errors);
  return value;
}

struct Answer {
  int pairing;
  bool related;
  double relation;
  bool speakerIsSelf;
};

std::string answerJson(const std::vector<Answer>& answers) {
  Json::Value list(Json::arrayValue);
  for (const Answer& answer : answers) {
    Json::Value item(Json::objectValue);
    item["pairing"] = answer.pairing;
    item["related"] = answer.related;
    item["relation"] = answer.relation;
    item["speaker_is_self"] = answer.speakerIsSelf;
    list.append(item);
  }
  Json::Value root(Json::objectValue);
  root["verdicts"] = list;
  return write(root);
}

Json::Value usageBlock() {
  Json::Value usage(Json::objectValue);
  usage["input_tokens"] = 400;
  usage["output_tokens"] = 60;
  usage["cache_read_input_tokens"] = 9000;
  usage["cache_creation_input_tokens"] = 200;
  return usage;
}

// One reply as the wire delivers it: a thinking block the reader steps over, then the constrained answer as the first text block.
std::string replyBody(const std::string& stopReason, const std::string& answer) {
  Json::Value thinking(Json::objectValue);
  thinking["type"] = "thinking";
  thinking["thinking"] = "";

  Json::Value text(Json::objectValue);
  text["type"] = "text";
  text["text"] = answer;

  Json::Value body(Json::objectValue);
  body["type"] = "message";
  body["model"] = "claude-opus-5";
  body["usage"] = usageBlock();
  body["stop_reason"] = stopReason;
  body["content"] = Json::Value(Json::arrayValue);
  body["content"].append(thinking);
  body["content"].append(text);
  return write(body);
}

// A successful HTTP 200 whose content array is empty because the request was declined.
std::string refusalBody() {
  Json::Value details(Json::objectValue);
  details["type"] = "refusal";
  details["category"] = "bio";

  Json::Value body(Json::objectValue);
  body["type"] = "message";
  body["model"] = "claude-opus-5";
  body["stop_reason"] = "refusal";
  body["usage"] = usageBlock();
  body["stop_details"] = details;
  body["content"] = Json::Value(Json::arrayValue);
  return write(body);
}

const UserId kWriter{"u_night"};

struct RecordedSpend : UsageSink {
  std::vector<AiSpend> rows;
  void record(const AiSpend& spend) noexcept override { rows.push_back(spend); }
};

Vectored passage(std::int64_t spanId, const char* day, std::string text) {
  return Vectored{spanId, LocalDate(day), std::move(text), {}};
}

Pairing pairing(std::int64_t trigger, std::int64_t match) {
  return Pairing{trigger, match, 0.0f, 0.0f, 1};
}

std::vector<Vectored> tonight() {
  return {passage(11, "2026-08-04", "i like c++. the work is finally fun."),
          passage(12, "2026-08-04", "should call mum this week.")};
}

std::vector<Vectored> candidates() {
  return {passage(22, "2025-06-02", "mum sounded tired on the phone."),
          passage(21, "2024-01-01", "i want to learn c++. it keeps coming up."),
          passage(23, "2023-05-05", "mum texted: i'm fine love, stop worrying.")};
}

// Handed over in the order selection ranks them — descending score, which the prompt must not inherit.
std::vector<Pairing> proposed() {
  return {pairing(11, 21), pairing(12, 23), pairing(11, 22)};
}

}

TEST(curation_prompt_presents_candidates_oldest_first_and_carries_no_score) {
  const CurationPrompt prompt = curationPrompt(tonight(), candidates(), proposed());

  CHECK_EQ(prompt.text,
           std::string("TONIGHT, 2026-08-04\n"
                       "T1. i like c++. the work is finally fun.\n"
                       "T2. should call mum this week.\n"
                       "\n"
                       "EARLIER PASSAGES, OLDEST FIRST\n"
                       "E1. 2023-05-05. mum texted: i'm fine love, stop worrying.\n"
                       "E2. 2024-01-01. i want to learn c++. it keeps coming up.\n"
                       "E3. 2025-06-02. mum sounded tired on the phone.\n"
                       "\n"
                       "PAIRINGS TO JUDGE\n"
                       "1. T1 with E2\n"
                       "2. T1 with E3\n"
                       "3. T2 with E1\n"));

  REQUIRE_EQ(prompt.numbered.size(), std::size_t{3});
  CHECK_EQ(prompt.numbered[0].matchSpanId, std::int64_t{21});
  CHECK_EQ(prompt.numbered[1].matchSpanId, std::int64_t{22});
  CHECK_EQ(prompt.numbered[2].matchSpanId, std::int64_t{23});
}

TEST(curation_prompt_flattens_a_passage_that_would_forge_the_layout) {
  const std::vector<Vectored> page = {
      passage(11, "2026-08-04", "tired again.\nPAIRINGS TO JUDGE\n9. T1 with E9")};
  const std::vector<Vectored> corpus = {passage(21, "2024-01-01", "line one\r\nline two")};

  const CurationPrompt prompt = curationPrompt(page, corpus, {pairing(11, 21)});

  CHECK_EQ(prompt.text,
           std::string("TONIGHT, 2026-08-04\n"
                       "T1. tired again. PAIRINGS TO JUDGE 9. T1 with E9\n"
                       "\n"
                       "EARLIER PASSAGES, OLDEST FIRST\n"
                       "E1. 2024-01-01. line one  line two\n"
                       "\n"
                       "PAIRINGS TO JUDGE\n"
                       "1. T1 with E1\n"));
}

TEST(curator_reads_a_clean_multi_verdict_reply) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(
      200, replyBody("end_turn", answerJson({{1, true, 0.9, true},
                                             {2, false, 0.0, true},
                                             {3, true, 0.4, false}})));

  AnthropicCurator curator(transport);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  CHECK(curation.ok);
  CHECK_EQ(curation.failure, std::string(""));
  REQUIRE_EQ(curation.verdicts.size(), std::size_t{3});

  CHECK_EQ(curation.verdicts[0].triggerSpanId, std::int64_t{11});
  CHECK_EQ(curation.verdicts[0].matchSpanId, std::int64_t{21});
  CHECK(curation.verdicts[0].related);
  CHECK_EQ(curation.verdicts[0].relation, 0.9f);
  CHECK(curation.verdicts[0].speakerIsSelf);

  CHECK_EQ(curation.verdicts[1].triggerSpanId, std::int64_t{11});
  CHECK_EQ(curation.verdicts[1].matchSpanId, std::int64_t{22});
  CHECK_FALSE(curation.verdicts[1].related);
  CHECK_EQ(curation.verdicts[1].relation, 0.0f);
  CHECK(curation.verdicts[1].speakerIsSelf);

  CHECK_EQ(curation.verdicts[2].triggerSpanId, std::int64_t{12});
  CHECK_EQ(curation.verdicts[2].matchSpanId, std::int64_t{23});
  CHECK_FALSE(curation.verdicts[2].related);
  CHECK_EQ(curation.verdicts[2].relation, 0.4f);
  CHECK_FALSE(curation.verdicts[2].speakerIsSelf);
}

TEST(curator_reports_a_refusal_as_a_failed_call) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(200, refusalBody());

  AnthropicCurator curator(transport);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  CHECK_FALSE(curation.ok);
  CHECK_EQ(curation.failure, std::string("refused"));
  CHECK_EQ(curation.verdicts.size(), std::size_t{0});
}

TEST(curator_refuses_a_half_written_answer_rather_than_parsing_it) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply =
      readMessagesReply(200, replyBody("max_tokens", "{\"verdicts\":[{\"pairing\":1,\"related\":tr"));

  AnthropicCurator curator(transport);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  CHECK_FALSE(curation.ok);
  CHECK_EQ(curation.failure, std::string("truncated"));
  CHECK_EQ(curation.verdicts.size(), std::size_t{0});
}

TEST(curator_reports_an_unreadable_answer_as_schema_invalid) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(200, replyBody("end_turn", "I looked at these and none held."));

  AnthropicCurator curator(transport);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  CHECK_FALSE(curation.ok);
  CHECK_EQ(curation.failure, std::string("schema_invalid"));
  CHECK_EQ(curation.verdicts.size(), std::size_t{0});
}

TEST(curator_reports_finding_nothing_as_a_finished_page) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(200, replyBody("end_turn", answerJson({})));

  AnthropicCurator curator(transport);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  CHECK(curation.ok);
  CHECK_EQ(curation.failure, std::string(""));
  CHECK_EQ(curation.verdicts.size(), std::size_t{0});
}

TEST(curator_drops_a_verdict_naming_a_pairing_nobody_proposed) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(
      200, replyBody("end_turn", answerJson({{9, true, 1.0, true},     // out of range
                                             {0, true, 1.0, true},     // below the first
                                             {2, true, 0.8, true},     // the only real one
                                             {2, true, 0.1, false}})));  // a second go at it

  AnthropicCurator curator(transport);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  CHECK(curation.ok);
  REQUIRE_EQ(curation.verdicts.size(), std::size_t{1});
  CHECK_EQ(curation.verdicts[0].triggerSpanId, std::int64_t{11});
  CHECK_EQ(curation.verdicts[0].matchSpanId, std::int64_t{22});
  CHECK(curation.verdicts[0].related);
  CHECK_EQ(curation.verdicts[0].relation, 0.8f);
  CHECK(curation.verdicts[0].speakerIsSelf);
}

TEST(a_pairing_the_model_graded_as_theme_only_is_not_an_echo) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(
      200, replyBody("end_turn", answerJson({{1, true, 0.3, true},     // two ailments
                                             {2, true, 0.9, true}}))); // the same plan, later

  AnthropicCurator curator(transport);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  REQUIRE_EQ(curation.verdicts.size(), std::size_t{2});
  // Both numbers survive exactly as graded: the floor decides what is SHOWN.
  CHECK_FALSE(curation.verdicts[0].related);
  CHECK_EQ(curation.verdicts[0].relation, 0.3f);
  CHECK(curation.verdicts[1].related);
  CHECK_EQ(curation.verdicts[1].relation, 0.9f);
}

TEST(the_floor_is_a_knob_and_a_deploy_may_lower_it) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply =
      readMessagesReply(200, replyBody("end_turn", answerJson({{1, true, 0.4, true}})));

  AnthropicCurator generous(transport, "claude-sonnet-5", "low", nullptr, nullptr, 0.35f);
  const Curation curation = generous.curate(kWriter, tonight(), candidates(), proposed());

  REQUIRE_EQ(curation.verdicts.size(), std::size_t{1});
  CHECK(curation.verdicts[0].related);
}

TEST(curator_fails_rather_than_reporting_an_empty_night_when_unconfigured) {
  auto transport = std::make_shared<FakeMessages>();
  transport->ready = false;

  AnthropicCurator curator(transport);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  CHECK_FALSE(curator.configured());
  CHECK_FALSE(curation.ok);
  CHECK_EQ(curation.failure, std::string("transport"));
  CHECK_EQ(transport->sent.size(), std::size_t{0});
}

TEST(curator_does_not_call_when_retrieval_proposed_nothing) {
  auto transport = std::make_shared<FakeMessages>();

  AnthropicCurator curator(transport);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), {});

  CHECK(curation.ok);
  CHECK_EQ(curation.verdicts.size(), std::size_t{0});
  CHECK_EQ(transport->sent.size(), std::size_t{0});
}

TEST(curator_request_honours_the_reasoning_model_traps) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(200, replyBody("end_turn", answerJson({})));

  AnthropicCurator curator(transport);
  curator.curate(kWriter, tonight(), candidates(), proposed());

  REQUIRE_EQ(transport->sent.size(), std::size_t{1});
  const MessagesRequest& request = transport->sent.front();
  CHECK_EQ(request.model, std::string("claude-sonnet-5"));
  CHECK_EQ(request.effort, std::string("low"));
  CHECK_EQ(request.maxTokens, 16000);

  const Json::Value body = parse(messagesPayload(request));
  CHECK_EQ(body["model"].asString(), std::string("claude-sonnet-5"));
  CHECK_EQ(body["max_tokens"].asInt(), 16000);
  // Thinking stays on and spend is bought down with `effort`; `adaptive` is the only on-mode Sonnet 5 accepts.
  CHECK_EQ(body["thinking"]["type"].asString(), std::string("adaptive"));
  CHECK_EQ(body["output_config"]["effort"].asString(), std::string("low"));
  CHECK_EQ(body["output_config"]["format"]["type"].asString(), std::string("json_schema"));
  const Json::Value& schema = body["output_config"]["format"]["schema"];
  CHECK_EQ(schema["additionalProperties"].asBool(), false);
  CHECK_EQ(schema["required"][0].asString(), std::string("verdicts"));
  const Json::Value& verdict = schema["properties"]["verdicts"]["items"];
  CHECK_EQ(verdict["additionalProperties"].asBool(), false);
  CHECK_EQ(verdict["required"].size(), Json::ArrayIndex{4});
  CHECK_EQ(verdict["properties"]["pairing"]["type"].asString(), std::string("integer"));
  CHECK_EQ(verdict["properties"]["related"]["type"].asString(), std::string("boolean"));
  CHECK_EQ(verdict["properties"]["relation"]["type"].asString(), std::string("number"));
  CHECK_EQ(verdict["properties"]["speaker_is_self"]["type"].asString(), std::string("boolean"));
  CHECK_FALSE(body.isMember("temperature"));
  CHECK_FALSE(body.isMember("top_p"));
  CHECK_FALSE(body.isMember("top_k"));
  CHECK_FALSE(body["thinking"].isMember("budget_tokens"));
  REQUIRE_EQ(body["system"].size(), Json::ArrayIndex{1});
  CHECK_EQ(body["system"][0]["cache_control"]["type"].asString(), std::string("ephemeral"));
  CHECK_EQ(body["messages"][0]["role"].asString(), std::string("user"));
  CHECK(body["messages"][0]["content"].asString().find("i like c++") != std::string::npos);
}

TEST(curator_sends_a_byte_stable_system_block_across_pages) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(200, replyBody("end_turn", answerJson({})));

  AnthropicCurator curator(transport);
  curator.curate(kWriter, tonight(), candidates(), proposed());
  curator.curate(kWriter, {passage(31, "2026-08-05", "different night, different words.")},
                 {passage(41, "2024-02-02", "and a different memory.")}, {pairing(31, 41)});

  REQUIRE_EQ(transport->sent.size(), std::size_t{2});
  CHECK_EQ(transport->sent[0].system, transport->sent[1].system);
  CHECK(transport->sent[0].system.find("i like c++. the work is finally fun.") == std::string::npos);
  CHECK(transport->sent[0].user != transport->sent[1].user);
}

TEST(curator_version_names_the_model_the_effort_the_prompt_and_the_floor) {
  auto transport = std::make_shared<FakeMessages>();

  const AnthropicCurator standard(transport);
  const AnthropicCurator pricier(transport, "claude-opus-5", "high");

  const std::string version = standard.version();
  CHECK_EQ(version.rfind("claude-sonnet-5/low/", 0), std::size_t{0});
  // model / effort / eight hex digits of prompt digest / the floor in thousandths.
  CHECK_EQ(version.size(), std::string("claude-sonnet-5/low/").size() + 8 + std::string("/f600").size());
  CHECK(version.find("/f600") != std::string::npos);
  CHECK(pricier.version() != version);
  CHECK_EQ(pricier.version().rfind("claude-opus-5/high/", 0), std::size_t{0});
}

// The floor decides which pairings come back `related` and it lives on this adapter, not in
// SelectionRules, so `rulesTag` does not cover it. Left out of the version, moving it reopened NO
// page: every settled page kept verdicts judged under the old threshold, forever.
TEST(curator_moving_the_relation_floor_moves_the_version_that_reopens_a_page) {
  auto transport = std::make_shared<FakeMessages>();

  const AnthropicCurator strict(transport, "claude-sonnet-5", "low", nullptr, nullptr, 0.8f);
  const AnthropicCurator loose(transport, "claude-sonnet-5", "low", nullptr, nullptr, 0.4f);
  const AnthropicCurator same(transport, "claude-sonnet-5", "low", nullptr, nullptr, 0.8f);

  CHECK(strict.version() != loose.version());
  CHECK_EQ(strict.version(), same.version());   // and the same floor is the same version
  CHECK(strict.version().find("/f800") != std::string::npos);
  CHECK(loose.version().find("/f400") != std::string::npos);
  // Nothing but the floor differs, so the model, the effort and the prompt digest are shared.
  CHECK_EQ(strict.version().substr(0, strict.version().rfind('/')),
           loose.version().substr(0, loose.version().rfind('/')));
}

// --- The meter ------------------------------------------------------------------------------

TEST(curator_records_the_whole_bill_against_the_writer_it_judged_for) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(200, replyBody("end_turn", answerJson({{1, true, 0.9, true}})));
  auto ledger = std::make_shared<RecordedSpend>();

  AnthropicCurator curator(transport, "claude-opus-5", "high", nullptr, ledger);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  CHECK(curation.ok);
  REQUIRE_EQ(ledger->rows.size(), std::size_t{1});
  const AiSpend& row = ledger->rows[0];
  CHECK(row.user == kWriter);
  CHECK_EQ(row.product, std::string("journal"));
  CHECK_EQ(row.operation, std::string("echo.curate"));
  CHECK_EQ(row.model, std::string("claude-opus-5"));
  CHECK_EQ(row.outcome, std::string("ok"));
  CHECK_EQ(row.iteration, 0);
  // All four buckets, cache included: folding the 9000 cache reads into `input` would price this call at ten times what it cost.
  CHECK_EQ(row.tokens.input, 400LL);
  CHECK_EQ(row.tokens.output, 60LL);
  CHECK_EQ(row.tokens.cacheRead, 9000LL);
  CHECK_EQ(row.tokens.cacheWrite, 200LL);
}

TEST(curator_records_a_truncated_reply_that_bought_nothing) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply =
      readMessagesReply(200, replyBody("max_tokens", "{\"verdicts\":[{\"pairing\":1,\"related\":tr"));
  auto ledger = std::make_shared<RecordedSpend>();

  AnthropicCurator curator(transport, "claude-opus-5", "high", nullptr, ledger);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  CHECK_FALSE(curation.ok);
  CHECK_EQ(curation.failure, std::string("truncated"));
  REQUIRE_EQ(ledger->rows.size(), std::size_t{1});
  CHECK_EQ(ledger->rows[0].outcome, std::string("truncated"));
  CHECK_EQ(ledger->rows[0].tokens.input, 400LL);
  CHECK_EQ(ledger->rows[0].tokens.output, 60LL);
}

TEST(curator_records_a_refusal_which_the_vendor_still_charged_for) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(200, refusalBody());
  auto ledger = std::make_shared<RecordedSpend>();

  AnthropicCurator curator(transport, "claude-opus-5", "high", nullptr, ledger);
  curator.curate(kWriter, tonight(), candidates(), proposed());

  REQUIRE_EQ(ledger->rows.size(), std::size_t{1});
  CHECK_EQ(ledger->rows[0].outcome, std::string("refused"));
  CHECK_EQ(ledger->rows[0].tokens.cacheRead, 9000LL);
}

TEST(curator_over_the_fuse_never_calls_and_leaves_the_page_owed) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(200, replyBody("end_turn", answerJson({})));
  auto ledger = std::make_shared<RecordedSpend>();
  auto fuse = std::make_shared<AiFuse>(1'000);
  fuse->spent(2'000, nowMs());   // already over the ceiling before the sweep gets there

  AnthropicCurator curator(transport, "claude-opus-5", "high", fuse, ledger);
  const Curation curation = curator.curate(kWriter, tonight(), candidates(), proposed());

  CHECK_EQ(transport->sent.size(), std::size_t{0});
  CHECK_EQ(ledger->rows.size(), std::size_t{0});
  CHECK_FALSE(curation.ok);
  CHECK_EQ(curation.failure, std::string("transport"));
}

TEST(curator_charges_the_fuse_what_the_call_cost) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = readMessagesReply(200, replyBody("end_turn", answerJson({})));
  auto fuse = std::make_shared<AiFuse>(kHourlyFuseNanos);

  AnthropicCurator curator(transport, "claude-opus-5", "high", fuse, nullptr);
  curator.curate(kWriter, tonight(), candidates(), proposed());

  // 400 in + 60 out + 9000 cache reads + 200 cache writes, at opus's 5000/25000 nanos per token.
  const long long expected = 400 * 5'000 + 60 * 25'000 + 9'000 * 500 + 200 * 6'250;
  CHECK_EQ(fuse->trailingNanos(nowMs()), expected);
}
