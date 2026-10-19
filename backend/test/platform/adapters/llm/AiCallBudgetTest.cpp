#include "platform/adapters/llm/AiCallBudget.h"
#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/adapters/llm/AgentLoop.h"
#include "platform/adapters/json/JsonText.h"
#include "platform/application/WriteObservation.h"
#include "test/platform/Fakes.h"
#include "test/platform/FakeAiBudgetRepository.h"
#include "test/testing.h"

#include <algorithm>
#include <map>
#include <stdexcept>

using namespace wm;
using namespace wm::fake;

namespace {
struct Failures : FailureReporter {
  std::vector<std::string> reports;
  void report(const std::string& kind, const std::string& where, const std::string& detail) override {
    reports.push_back(kind + ":" + where + ":" + detail);
  }
};
}

TEST(ai_call_output_offer_preserves_full_input_image_cache_and_framing_estimate) {
  auto request = parse(R"({"model":"claude-opus-5","max_tokens":2000,"system":[
      {"type":"text","text":"Coach","cache_control":{"type":"ephemeral"}}],"messages":[
      {"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}]})");
  const auto full = anthropicReservationNanos(request);
  const auto offer = anthropicOutputBudget(request, 1'024);
  REQUIRE(full);
  REQUIRE(offer);
  CHECK_EQ(offer->inputNanos, *full - 50'000'000);
  CHECK_EQ(offer->outputTokenNanos, 25'000);
  CHECK_EQ(offer->minTokens, 1'024);
  CHECK_EQ(offer->maxTokens, 2'000);
  request["max_tokens"] = 1'024;
  CHECK_EQ(anthropicReservationNanos(request), std::optional<long long>{offer->costNanos(1'024)});
  request["max_tokens"] = 10'000;
  const auto wider = anthropicOutputBudget(request, 1'024);
  REQUIRE(wider);
  request["max_tokens"] = 1'024;
  CHECK(*anthropicReservationNanos(request) <= wider->costNanos(1'024));
  for (const int floor : {-1, 0, 1'025}) CHECK_FALSE(anthropicOutputBudget(request, floor));
  request["thinking"] = parse(R"({"type":"enabled","budget_tokens":1024})");
  CHECK_FALSE(anthropicOutputBudget(request, 1'024));
  request["thinking"] = parse(R"({"type":"adaptive"})");
  CHECK(anthropicOutputBudget(request, 1'024));
}

TEST(ai_call_output_cap_matches_reservation_and_changes_with_next_round_context_and_spend) {
  FakeAiBudgetRepository repository;
  const AiBudgetLimits limits;
  auto service = std::make_shared<AiBudgetService>(repository, [=] { return limits; }, [] { return 1'792'000'000'000LL; });
  FakeAuthRepository accounts;
  const auto account = accounts.createUser(Email{"free@example.com"}, "Free");
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository ledger;
  Entitlements entitlements{subscriptions, ledger, {}, {}, service};
  Failures failures;
  auto budget = std::make_shared<AiCallBudget>(service, entitlements, accounts, failures);
  AiSpend spend;
  spend.user = account.id;
  spend.model = "claude-opus-5";
  auto request = parse(R"({"model":"claude-opus-5","max_tokens":2000,"system":[
      {"type":"text","text":"Coach","cache_control":{"type":"ephemeral"}}],
      "messages":[{"role":"user","content":"Create routines"}]})");
  const auto original = request;
  const auto firstOffer = anthropicOutputBudget(request, 1'024);
  REQUIRE(firstOffer);
  repository.totals.subject.spentNanos = limits.loggedInMonthlyNanos - firstOffer->costNanos(1'700);
  std::vector<int> caps;
  std::string refusal;
  const auto reply = parse(R"({"stop_reason":"end_turn","content":[{"type":"text","text":"Ready"}],
      "usage":{"input_tokens":100,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}})");
  auto call = metered([&](const Json::Value& outbound) -> std::optional<Json::Value> {
    const auto cap = outbound["max_tokens"].asInt();
    caps.push_back(cap);
    auto expected = request;
    expected["max_tokens"] = cap;
    CHECK_EQ(outbound, expected);
    const auto active = std::find_if(repository.reservations.begin(), repository.reservations.end(),
        [](const auto& row) { return row.second.state == AiBudgetState::Dispatched; });
    CHECK(active != repository.reservations.end());
    if (active == repository.reservations.end()) return std::nullopt;
    CHECK_EQ(active->second.outputBudget->tokensFor(active->second.amountNanos), std::optional<int>{cap});
    CHECK_EQ(active->second.amountNanos, *anthropicReservationNanos(outbound));
    return reply;
  }, spend, {}, {}, {}, {}, budget, [&](const std::string& code) { refusal = code; }, 1'024);
  REQUIRE(call(request));
  CHECK_EQ(request, original);
  CHECK_EQ(caps, (std::vector<int>{1'700}));
  repository.totals.subject.spentNanos += *anthropicActualNanos(spend.model, reply["usage"]);
  request["messages"].append(parse(R"({"role":"assistant","content":"Read the catalog"})"));
  request["messages"].append(parse(R"({"role":"user","content":""})"));
  request["messages"][2]["content"] = std::string(3'000, 'a');
  const auto nextOffer = anthropicOutputBudget(request, 1'024);
  REQUIRE(nextOffer);
  const auto expected = static_cast<int>((limits.loggedInMonthlyNanos - repository.totals.subject.spentNanos -
      nextOffer->inputNanos) / nextOffer->outputTokenNanos);
  REQUIRE(call(request));
  CHECK_EQ(caps, (std::vector<int>{1'700, expected}));
  CHECK(expected >= 1'024 && expected < 1'700);
  for (const auto& [id, reservation] : repository.reservations) {
    CHECK_EQ(reservation.state, AiBudgetState::Settled);
    CHECK_EQ(reservation.actualNanos, anthropicActualNanos(spend.model, reply["usage"]));
  }
  repository.totals.subject.spentNanos = limits.loggedInMonthlyNanos - nextOffer->costNanos(1'024) + 1;
  CHECK_FALSE(call(request));
  CHECK_EQ(refusal, "subject_exhausted");
  CHECK_EQ(caps.size(), 2u);
  CHECK_EQ(repository.reservations.size(), 2u);
  repository.totals.concurrentCalls = 1;
  CHECK_FALSE(call(request));
  CHECK_EQ(refusal, "concurrency_exhausted");
  CHECK_EQ(caps.size(), 2u);
  CHECK(failures.reports.empty());
  auto disabled = metered([&](const Json::Value& outbound) -> std::optional<Json::Value> {
    CHECK_EQ(outbound, request);
    return reply;
  }, spend, {}, {}, {}, {}, {}, {}, 1'024);
  REQUIRE(disabled(request));
}

TEST(ai_call_adaptive_truncation_settles_without_tools_and_transport_retains_hold) {
  for (const std::string failure : {"max_tokens", "transport", "dispatch"}) {
    struct Repository : FakeAiBudgetRepository {
      bool refuseDispatch = false;
      AiBudgetResult markDispatched(const std::string& id) override {
        if (refuseDispatch) return {AiBudgetCode::InvalidState};
        return FakeAiBudgetRepository::markDispatched(id);
      }
    } repository;
    auto service = std::make_shared<AiBudgetService>(repository, [] { return AiBudgetLimits{}; }, [] { return 1'792'000'000'000LL; });
    FakeAuthRepository accounts;
    const auto account = accounts.createUser(Email{"free@example.com"}, "Free");
    FakeSubscriptionRepository subscriptions;
    FakeAiUsageRepository ledger;
    Entitlements entitlements{subscriptions, ledger, {}, {}, service};
    Failures failures;
    auto budget = std::make_shared<AiCallBudget>(service, entitlements, accounts, failures);
    AiSpend spend;
    spend.user = account.id;
    spend.model = "claude-opus-5";
    repository.refuseDispatch = failure == "dispatch";
    struct Tools : ToolHost {
      int writes = 0;
      std::vector<ToolDeclaration> declareTools() const override { return {}; }
      ToolResult callTool(const std::string&, const Json::Value&, const ToolCaller&) override {
        ++writes;
        return ToolResult::text("written");
      }
    } tools;
    int sends = 0;
    auto call = metered([&](const Json::Value& outbound) -> std::optional<Json::Value> {
      ++sends;
      if (failure == "transport") return std::nullopt;
      auto reply = parse(R"({"stop_reason":"max_tokens","content":[{"type":"tool_use","id":"tool", "name":"create_routine","input":{}}],
          "usage":{"input_tokens":100,"output_tokens":2000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}})");
      reply["usage"]["output_tokens"] = outbound["max_tokens"];
      return reply;
    }, spend, {}, {}, {}, {}, budget, {}, 1'024);
    AgentLoopSpec spec;
    spec.model = spend.model;
    spec.maxTokens = 2'000;
    spec.messages = parse(R"([{"role":"user","content":"Create a routine"}])");
    std::vector<std::string> reports;
    const auto outcome = driveAgentLoop(spec, tools, {}, call,
        [&](const std::string& where, const std::string& detail) { reports.push_back(where + ":" + detail); });
    CHECK_FALSE(outcome.ok);
    CHECK_EQ(reports, (std::vector<std::string>{failure == "max_tokens"
        ? "agent.run:the model stopped early (stop_reason: max_tokens)"
        : "agent.run:the model call failed or returned an unreadable reply"}));
    CHECK_EQ(tools.writes, 0);
    CHECK_EQ(sends, failure == "dispatch" ? 0 : 1);
    REQUIRE_EQ(repository.reservations.size(), 1u);
    const auto& reservation = repository.reservations.begin()->second;
    CHECK(reservation.outputBudget);
    CHECK_EQ(reservation.state, failure == "max_tokens" ? AiBudgetState::Settled :
        failure == "transport" ? AiBudgetState::Uncertain : AiBudgetState::Reserved);
    if (failure == "max_tokens") CHECK_EQ(reservation.actualNanos, std::optional<long long>{50'500'000});
    else CHECK_FALSE(reservation.actualNanos);
  }
}

TEST(ai_call_budget_estimates_actual_text_history_tools_results_and_output_schema) {
  auto request = parse(R"({"model":"claude-sonnet-5","max_tokens":100,
      "messages":[{"role":"user","content":"Hi"}]})");
  const auto shortRequest = anthropicReservationNanos(request);
  REQUIRE(shortRequest);
  CHECK(*shortRequest > 1'000'000);
  CHECK(*shortRequest < 1'500'000);
  request["system"] = std::string(3'000, 'a');
  const auto system = anthropicReservationNanos(request);
  REQUIRE(system);
  request["system"] = std::string(6'000, 'a');
  CHECK_EQ(anthropicReservationNanos(request), std::optional<long long>{*system + 2'000'000});
  request["messages"].append(parse(R"({"role":"assistant","content":"Earlier answer"})"));
  request["messages"].append(parse(R"({"role":"user","content":"Next question"})"));
  const auto history = anthropicReservationNanos(request);
  REQUIRE(history);
  CHECK(*history > *system + 2'000'000);
  request["tools"] = parse(R"([{"name":"read_log","description":"Read a log","input_schema":{
      "type":"object","properties":{"day":{"type":"string"}},"required":["day"]}}])");
  const auto tools = anthropicReservationNanos(request);
  REQUIRE(tools);
  CHECK(*tools > *history + 700'000);
  request["tools"][0]["input_schema"]["description"] = std::string(3'000, 'a');
  const auto schema = anthropicReservationNanos(request);
  REQUIRE(schema);
  request["tools"][0]["input_schema"]["description"] = std::string(6'000, 'a');
  CHECK_EQ(anthropicReservationNanos(request), std::optional<long long>{*schema + 2'000'000});
  request["messages"].append(parse(R"({"role":"assistant","content":[
      {"type":"tool_use","id":"tool-1","name":"read_log","input":{"day":"2026-10-19"}}]})"));
  request["messages"].append(parse(R"({"role":"user","content":[
      {"type":"tool_result","tool_use_id":"tool-1","content":""}]})"));
  request["messages"][4]["content"][0]["content"] = std::string(3'000, 'a');
  const auto result = anthropicReservationNanos(request);
  REQUIRE(result);
  request["messages"][4]["content"][0]["content"] = std::string(6'000, 'a');
  CHECK_EQ(anthropicReservationNanos(request), std::optional<long long>{*result + 2'000'000});
  request["messages"][3]["content"][0]["input"]["type"] = "image";
  request["messages"][3]["content"][0]["input"]["source"]["data"] = std::string(3'000, 'a');
  const auto literalImageFields = anthropicReservationNanos(request);
  REQUIRE(literalImageFields);
  request["messages"][3]["content"][0]["input"]["source"]["data"] = std::string(6'000, 'a');
  CHECK_EQ(anthropicReservationNanos(request), std::optional<long long>{*literalImageFields + 2'000'000});
  request["output_config"]["format"] = parse(R"({"type":"json_schema","schema":{"type":"object"}})");
  request["output_config"]["format"]["schema"]["description"] = std::string(3'000, 'a');
  const auto outputSchema = anthropicReservationNanos(request);
  REQUIRE(outputSchema);
  request["output_config"]["format"]["schema"]["description"] = std::string(6'000, 'a');
  CHECK_EQ(anthropicReservationNanos(request), std::optional<long long>{*outputSchema + 2'000'000});
}

TEST(ai_call_budget_prices_images_by_block_and_model_without_counting_base64_as_text) {
  auto request = parse(R"({"model":"claude-sonnet-5","max_tokens":100,"messages":[
      {"role":"user","content":[{"type":"text","text":"Describe these photos"}]}]})");
  const auto text = anthropicReservationNanos(request);
  REQUIRE(text);
  const auto image = parse(R"({"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}})");
  request["messages"][0]["content"].append(image);
  const auto oneImage = anthropicReservationNanos(request);
  REQUIRE(oneImage);
  CHECK(*oneImage > *text + 9'568'000);
  CHECK(*oneImage < *text + 10'000'000);
  request["messages"][0]["content"][1]["source"]["data"] = std::string(40'000, 'A');
  CHECK_EQ(anthropicReservationNanos(request), oneImage);
  request["messages"].append(parse(R"({"role":"assistant","content":"First photo reviewed"})"));
  request["messages"].append(parse(R"({"role":"user","content":[]})"));
  request["messages"][2]["content"].append(image);
  const auto historyImages = anthropicReservationNanos(request);
  REQUIRE(historyImages);
  CHECK(*historyImages > *oneImage + 9'568'000);
  request["model"] = "claude-sonnet-4-6";
  const auto older = anthropicReservationNanos(request);
  REQUIRE(older);
  CHECK(*older < *historyImages);
  request["model"] = "claude-sonnet-5";
  request["messages"][0]["content"][0]["cache_control"] = parse(R"({"type":"ephemeral","ttl":"5m"})");
  const auto cached = anthropicReservationNanos(request);
  REQUIRE(cached);
  CHECK(*cached > *historyImages);
  request["messages"][0]["content"][0]["other_control"] = request["messages"][0]["content"][0]["cache_control"];
  request["messages"][0]["content"][0].removeMember("cache_control");
  const auto uncached = anthropicReservationNanos(request);
  REQUIRE(uncached);
  CHECK_EQ((*cached - 1'000'000) * 4, (*uncached - 1'000'000) * 5);
}

TEST(ai_call_budget_counts_literal_cache_fields_without_treating_them_as_provider_markers) {
  auto request = parse(R"({"model":"claude-sonnet-5","max_tokens":100,"tools":[{"name":"save_data",
      "input_schema":{"type":"object","properties":{"cache_control":{"type":"string"}}}}],
      "messages":[{"role":"user","content":"Save this"},{"role":"assistant","content":[
      {"type":"tool_use","id":"tool-1","name":"save_data","input":{"cache_control":"user value"}}]}]})");
  REQUIRE(anthropicReservationNanos(request));
  auto& input = request["messages"][1]["content"][0]["input"];
  input["cache_control"] = parse(R"({"type":"ephemeral"})");
  const auto literalMarker = anthropicReservationNanos(request);
  REQUIRE(literalMarker);
  input["other_control"] = input["cache_control"];
  input.removeMember("cache_control");
  CHECK_EQ(anthropicReservationNanos(request), literalMarker);
}

TEST(ai_call_budget_refuses_unpriced_or_malformed_request_shapes) {
  const auto valid = parse(R"({"model":"claude-sonnet-5","max_tokens":100,
      "messages":[{"role":"user","content":"Hi"}]})");
  for (const auto* option : {"speed", "inference_geo", "service_tier", "betas", "container"}) {
    auto request = valid;
    request[option] = "unsupported";
    CHECK_FALSE(anthropicReservationNanos(request));
  }
  for (const auto* invalid : {
      R"({"model":"future-model"})", R"({"max_tokens":0})", R"({"max_tokens":128001})",
      R"({"messages":null})", R"({"messages":[]})", R"({"messages":[{"role":"system","content":"Hi"}]})",
      R"({"messages":[{"role":"user","content":7}]})", R"({"messages":[{"role":"user","content":[{"type":"document"}]}]})",
      R"({"messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"https://example.com/a.png"}}]}]})",
      R"({"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"??=="}}]}]})",
      R"({"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"application/pdf","data":"AAAA"}}]}]})",
      R"({"system":[{"type":"text","text":"Hi","cache_control":{"type":"ephemeral","ttl":"1h"}}]})",
      R"({"tools":[{"name":"search","type":"web_search_20250305","input_schema":{}}]})",
      R"({"tools":[{"name":"read_log","input_schema":"invalid"}]})"}) {
    auto request = valid;
    const auto replacement = parse(invalid);
    for (const auto& name : replacement.getMemberNames()) request[name] = replacement[name];
    CHECK_FALSE(anthropicReservationNanos(request));
  }
  auto oversized = valid;
  oversized["messages"][0]["content"] = std::string(3'000'001, 'a');
  CHECK_FALSE(anthropicReservationNanos(oversized));
}

TEST(ai_call_budget_resolves_account_tier_and_never_dispatches_anonymous_or_exhausted_work) {
  FakeAiBudgetRepository repository;
  AiBudgetLimits limits;
  auto service = std::make_shared<AiBudgetService>(repository, [&] { return limits; }, [] { return 1'792'000'000'000LL; });
  FakeAuthRepository accounts;
  const auto user = accounts.createUser(Email{"owner@example.com"}, "Owner");
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage, "owner@example.com", {}, service};
  Failures failures;
  auto budget = std::make_shared<AiCallBudget>(service, entitlements, accounts, failures);
  AiSpend spend;
  spend.model = "claude-sonnet-5";
  spend.product = "gym";
  spend.operation = "ask";
  Json::Value request;
  request["model"] = spend.model;
  request["max_tokens"] = 16'000;
  request["messages"] = parse(R"([{"role":"user","content":"Hi"}])");
  CHECK_EQ(budget->begin(spend, request).refusal, std::string{"device_verification_required"});
  CHECK(repository.reservations.empty());
  spend.user = user.id;
  const auto admission = budget->begin(spend, request);
  REQUIRE(admission.reservation);
  const auto& row = repository.reservations.at(admission.reservation->id);
  CHECK(row.tier == AiBudgetTier::WindmillOne);
  CHECK(row.subject == (AiBudgetSubject{AiBudgetSubjectKind::Account, user.id.str()}));
  CHECK(row.state == AiBudgetState::Dispatched);
  int sends = 0;
  repository.totals.concurrentCalls = limits.paidConcurrency;
  std::string refusal;
  auto call = metered([&](const Json::Value&) -> std::optional<Json::Value> { ++sends; return Json::Value(); },
      spend, {}, {}, {}, {}, budget, [&](const std::string& code) { refusal = code; });
  CHECK_FALSE(call(request));
  CHECK_EQ(sends, 0);
  CHECK_EQ(refusal, std::string(aiBudgetCodeName(AiBudgetCode::ConcurrencyExhausted)));
  CHECK_EQ(repository.reservations.size(), 1u);
}

TEST(ai_call_budget_settles_complete_usage_and_keeps_missing_or_partial_usage_reserved) {
  FakeAiBudgetRepository repository;
  AiBudgetLimits limits;
  auto service = std::make_shared<AiBudgetService>(repository, [&] { return limits; }, [] { return 1'792'000'000'000LL; });
  FakeAuthRepository accounts;
  const auto user = accounts.createUser(Email{"sam@example.com"}, "Sam");
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository ledger;
  Entitlements entitlements{subscriptions, ledger, "sam@example.com"};
  Failures failures;
  auto budget = std::make_shared<AiCallBudget>(service, entitlements, accounts, failures);
  AiSpend spend;
  spend.user = user.id;
  spend.model = "claude-sonnet-5";
  Json::Value request;
  request["model"] = spend.model;
  request["max_tokens"] = 16'000;
  request["messages"] = parse(R"([{"role":"user","content":"Hi"}])");
  Json::Value usage;
  usage["input_tokens"] = 100;
  usage["output_tokens"] = 200;
  usage["cache_read_input_tokens"] = 300;
  usage["cache_creation_input_tokens"] = 400;
  const auto complete = budget->begin(spend, request);
  REQUIRE(complete.reservation);
  budget->finish(*complete.reservation, spend.model, usage, true);
  CHECK(repository.reservations.at(complete.reservation->id).state == AiBudgetState::Settled);
  CHECK_EQ(repository.reservations.at(complete.reservation->id).actualNanos, std::optional<long long>{3'260'000});
  request["max_tokens"] = 200;
  const auto underestimated = budget->begin(spend, request);
  REQUIRE(underestimated.reservation);
  const auto actual = parse(R"({"input_tokens":1000,"output_tokens":200,
      "cache_read_input_tokens":0,"cache_creation_input_tokens":0})");
  REQUIRE(underestimated.reservation->amountNanos < 4'000'000);
  budget->finish(*underestimated.reservation, spend.model, actual, true);
  CHECK(repository.reservations.at(underestimated.reservation->id).state == AiBudgetState::Settled);
  CHECK_EQ(repository.reservations.at(underestimated.reservation->id).actualNanos, std::optional<long long>{4'000'000});
  request["max_tokens"] = 16'000;
  for (const bool missing : {false, true}) {
    const auto incomplete = budget->begin(spend, request);
    REQUIRE(incomplete.reservation);
    budget->finish(*incomplete.reservation, spend.model, missing ? Json::Value() : usage, false);
    CHECK(repository.reservations.at(incomplete.reservation->id).state == AiBudgetState::Uncertain);
    CHECK_FALSE(repository.reservations.at(incomplete.reservation->id).actualNanos);
    CHECK_EQ(repository.reservations.at(incomplete.reservation->id).amountNanos, incomplete.reservation->amountNanos);
  }
  usage.removeMember("output_tokens");
  CHECK_FALSE(anthropicActualNanos(spend.model, usage));
  const auto partial = budget->begin(spend, request);
  REQUIRE(partial.reservation);
  budget->finish(*partial.reservation, spend.model, usage, true);
  CHECK(repository.reservations.at(partial.reservation->id).state == AiBudgetState::Uncertain);
  CHECK_FALSE(repository.reservations.at(partial.reservation->id).actualNanos);
  struct ReporterScope {
    std::shared_ptr<Failures> reporter = std::make_shared<Failures>();
    ReporterScope() { installWriteReporter(reporter); }
    ~ReporterScope() { installWriteReporter(nullptr); }
  } scope;
  repository.failReserve = true;
  int sends = 0;
  auto call = metered([&](const Json::Value&) -> std::optional<Json::Value> { ++sends; return {}; }, spend,
      {}, {}, {}, {}, budget);
  CHECK_FALSE(call(request));
  CHECK_EQ(sends, 0);
  CHECK_EQ(scope.reporter->reports.size(), 1u);
  for (const auto& report : scope.reporter->reports) CHECK_EQ(report.find("private"), std::string::npos);
}

TEST(ai_call_budget_only_terminal_provider_replies_have_complete_usage) {
  for (const std::string stop : {"end_turn", "max_tokens", "refusal", "tool_use", "unknown", ""}) {
    Json::Value body;
    body["stop_reason"] = stop;
    body["usage"]["input_tokens"] = 10;
    body["usage"]["output_tokens"] = 20;
    body["usage"]["cache_read_input_tokens"] = 0;
    body["usage"]["cache_creation_input_tokens"] = 0;
    body["content"][0]["type"] = "text";
    body["content"][0]["text"] = "{}";
    Json::StreamWriterBuilder writer;
    const auto reply = readMessagesReply(200, Json::writeString(writer, body));
    CHECK_EQ(reply.usageComplete, stop != "unknown" && !stop.empty());
    CHECK_EQ(reply.tokens.output, 20);
  }
}

TEST(ai_call_budget_admits_small_free_requests_but_refuses_large_requests_and_unfunded_paid) {
  FakeAiBudgetRepository repository;
  auto service = std::make_shared<AiBudgetService>(repository, [] { return AiBudgetLimits{}; },
                                                   [] { return 1'792'000'000'000LL; });
  FakeAuthRepository accounts;
  const auto account = accounts.createUser(Email{"free@example.com"}, "Free");
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage, {}, {}, service};
  Failures failures;
  AiCallBudget budget{service, entitlements, accounts, failures};
  AiSpend spend;
  spend.user = account.id;
  spend.model = "claude-sonnet-5";
  spend.operation = "echo.segment";
  Json::Value request;
  request["model"] = spend.model;
  request["max_tokens"] = 16'000;
  request["messages"] = parse(R"([{"role":"user","content":"Hi"}])");
  CHECK_EQ(entitlements.aiAllowanceView(account.id, account.email.value).remainingNanos, 250'000'000);
  const auto small = budget.begin(spend, request);
  REQUIRE(small.reservation);
  CHECK(small.reservation->amountNanos < 250'000'000);
  request["messages"][0]["content"] = std::string(300'000, 'a');
  CHECK_EQ(budget.begin(spend, request).refusal, std::string{"subject_exhausted"});
  CHECK_EQ(repository.reservations.size(), 1u);
  subscriptions.subscribe(account.id);
  request["messages"][0]["content"] = "Hi";
  CHECK_EQ(budget.begin(spend, request).refusal, std::string{"funding_required"});
  CHECK_EQ(repository.reservations.size(), 1u);
  CHECK(failures.reports.empty());
}
