#include "platform/application/WriteObservation.h"
#include "platform/adapters/sentry/SentryClient.h"
#include "test/testing.h"

#include <stdexcept>
#include <algorithm>
#include <cmath>
#include <thread>
#include <typeinfo>

namespace {
struct Capture : wm::FailureReporter {
  std::vector<Json::Value> issues;
  void report(const std::string&, const std::string&, const std::string&) override {}
  void reportWrite(const std::string& operation, const std::string& product, const std::string& door,
                   const std::string& outcome, const std::string& id, const std::string& type) override {
    issues.push_back(wm::SentryClient::writeEvent(operation, product, door, outcome, id, type));
  }
};

struct Recording {
  std::shared_ptr<Capture> reporter = std::make_shared<Capture>();
  std::vector<wm::WriteCompletion> lines;
  Recording() {
    wm::installWriteReporter(reporter);
    wm::installWriteSink([this](const wm::WriteCompletion& completion) { lines.push_back(completion); });
  }
  ~Recording() {
    wm::installWriteSink({});
    wm::installWriteReporter({});
  }
};
}

TEST(WriteObservation_completion_is_once_and_contains_only_metadata) {
  Recording recording;
  wm::WriteObservation observation("journal.save", "journal", "rest");
  observation.finish();
  observation.finish("failed");
  REQUIRE(recording.lines.size() == 1);
  const auto& line = recording.lines[0];
  CHECK(line.operation == "journal.save");
  CHECK(line.product == "journal");
  CHECK(line.door == "rest");
  CHECK(line.outcome == "ok");
  CHECK(line.requestId.size() == 32);
  CHECK(line.durationMs >= 0);
  CHECK(line.severity == wm::WriteSeverity::info);
  CHECK(recording.reporter->issues.empty());
}

TEST(WriteObservation_expected_refusals_never_create_issues) {
  Recording recording;
  for (const std::string code : {"rate_limited", "gym-frozen", "guard-failed", "too-large"}) {
    wm::WriteObservation observation("gym.write", "gym", "mcp");
    observation.finish(code);
  }
  REQUIRE(recording.lines.size() == 4);
  CHECK(recording.lines[0].outcome == "rate_limited");
  CHECK(recording.lines[1].outcome == "gym-frozen");
  CHECK(recording.lines[2].outcome == "guard-failed");
  CHECK(recording.lines[3].outcome == "too-large");
  CHECK(std::all_of(recording.lines.begin(), recording.lines.end(), [](const auto& line) {
    return line.severity == wm::WriteSeverity::warn;
  }));
  CHECK(recording.reporter->issues.empty());
}

TEST(WriteObservation_nested_failure_reports_one_compiled_type_without_message) {
  Recording recording;
  wm::WriteObservation request("gym.write", "gym", "rest");
  wm::WriteContext context(request);
  wm::WriteObservation command("sync.command.gym.start", "gym", "command");
  const std::runtime_error error("SECRET_JOURNAL_QUESTION_TOKEN_EMAIL");
  command.fail(error);
  request.fail(error);
  REQUIRE(recording.lines.size() == 2);
  REQUIRE(recording.reporter->issues.size() == 1);
  const auto& issue = recording.reporter->issues[0];
  CHECK(issue["transaction"] == "sync.command.gym.start");
  CHECK(issue["tags"]["request_id"] == request.requestId());
  CHECK(issue["exception"]["values"][0]["type"] == typeid(error).name());
  CHECK(issue.toStyledString().find(error.what()) == std::string::npos);
  CHECK(recording.lines[0].requestId == recording.lines[1].requestId);
  CHECK(recording.lines[0].outcome == "failed");
  CHECK(recording.lines[1].outcome == "failed");
  CHECK(recording.lines[0].severity == wm::WriteSeverity::error);
  CHECK(recording.lines[1].severity == wm::WriteSeverity::error);
}

TEST(WriteObservation_nested_engine_successes_emit_one_info_for_the_outer_request) {
  Recording recording;
  wm::WriteObservation request("gym.save", "gym", "rest");
  wm::WriteContext requestContext(request);
  wm::WriteObservation server("gym.server_call", "gym", "server-origin");
  wm::WriteContext serverContext(server);
  wm::WriteObservation admission("sync.admit", "gym", "sync");
  wm::WriteContext admissionContext(admission);
  wm::WriteObservation command("sync.command.gym.start", "gym", "command");
  wm::WriteObservation publication("sync.publish", "gym", "background");
  publication.finish();
  command.finish();
  admission.finish();
  server.finish();
  request.finish();
  REQUIRE_EQ(recording.lines.size(), 5u);
  for (std::size_t i = 0; i != 4; ++i) {
    CHECK_EQ(recording.lines[i].severity, wm::WriteSeverity::debug);
    CHECK_EQ(recording.lines[i].requestId, request.requestId());
  }
  CHECK_EQ(recording.lines[4].operation, "gym.save");
  CHECK_EQ(recording.lines[4].severity, wm::WriteSeverity::info);
  CHECK_EQ(std::count_if(recording.lines.begin(), recording.lines.end(), [](const auto& line) {
    return line.severity == wm::WriteSeverity::info;
  }), 1);
}

TEST(WriteObservation_nested_refusals_and_failures_remain_visible_when_noop_success_is_skipped) {
  Recording recording;
  wm::WriteObservation request("gym.save", "gym", "rest");
  wm::WriteContext context(request);
  wm::WriteObservation noop("sync.publish", "gym", "background");
  noop.skip();
  noop.finish();
  wm::WriteObservation refusal("sync.command.gym.start", "gym", "command");
  refusal.finish("cap");
  wm::WriteObservation failure("sync.admit", "gym", "sync");
  failure.reportFailure(std::logic_error("PRIVATE-TOKEN"));
  failure.skip();
  request.finish();
  REQUIRE_EQ(recording.lines.size(), 3u);
  CHECK_EQ(recording.lines[0].outcome, "cap");
  CHECK_EQ(recording.lines[0].severity, wm::WriteSeverity::warn);
  CHECK_EQ(recording.lines[1].outcome, "failed");
  CHECK_EQ(recording.lines[1].severity, wm::WriteSeverity::error);
  CHECK_EQ(recording.lines[2].severity, wm::WriteSeverity::info);
  REQUIRE_EQ(recording.reporter->issues.size(), 1u);
  CHECK(recording.reporter->issues.front().toStyledString().find("PRIVATE") == std::string::npos);
}

TEST(WriteObservation_actual_write_count_is_shared_with_parent_across_workers) {
  Recording recording;
  wm::WriteObservation request("journal.retention", "journal", "background");
  CHECK_EQ(request.writeCount(), 0u);
  std::thread worker([&] {
    wm::WriteContext workerContext(request);
    wm::WriteObservation child("journal.prune", "journal", "background");
    wm::WriteContext childContext(child);
    child.wrote();
    wm::markCurrentWrite();
    CHECK_EQ(child.writeCount(), 2u);
    child.finish();
  });
  worker.join();
  CHECK_EQ(request.writeCount(), 2u);
  request.finish();
  REQUIRE_EQ(recording.lines.size(), 2u);
  CHECK_EQ(recording.lines[0].severity, wm::WriteSeverity::debug);
  CHECK_EQ(recording.lines[1].severity, wm::WriteSeverity::info);
  CHECK_EQ(recording.lines[0].requestId, recording.lines[1].requestId);
}

TEST(WriteObservation_auth_refresh_housekeeping_is_debug_and_does_not_claim_request_info) {
  Recording recording;
  {
    wm::WriteObservation refresh("auth.session.refresh", "platform", "background");
    refresh.wrote();
    refresh.finish();
  }
  {
    wm::WriteContext requestContext("internal-authenticated-request");
    wm::WriteObservation refresh("auth.session.refresh", "platform", "background");
    refresh.wrote();
    refresh.finish();
    wm::WriteObservation write("journal.save", "journal", "rest");
    write.finish();
  }
  REQUIRE_EQ(recording.lines.size(), 3u);
  CHECK_EQ(recording.lines[0].severity, wm::WriteSeverity::debug);
  CHECK_EQ(recording.lines[1].severity, wm::WriteSeverity::debug);
  CHECK_EQ(recording.lines[2].severity, wm::WriteSeverity::info);
  CHECK_EQ(recording.lines[1].requestId, recording.lines[2].requestId);
}

TEST(WriteObservation_duration_is_numeric_with_at_most_two_serialized_decimal_places) {
  Recording recording;
  wm::WriteObservation observation("journal.save", "journal", "rest");
  observation.finish();
  REQUIRE_EQ(recording.lines.size(), 1u);
  const auto& completion = recording.lines.front();
  CHECK(std::abs(completion.durationMs * 100 - std::round(completion.durationMs * 100)) < 1e-8);
  const auto json = wm::writeCompletionJson(completion);
  const auto key = json.find("\"duration_ms\":");
  REQUIRE(key != std::string::npos);
  const auto begin = key + std::string("\"duration_ms\":").size();
  const auto end = json.find(',', begin);
  const auto numeric = json.substr(begin, end - begin);
  CHECK(numeric.find('"') == std::string::npos);
  CHECK(numeric.find_first_of("eE") == std::string::npos);
  const auto decimal = numeric.find('.');
  CHECK(decimal == std::string::npos || numeric.size() - decimal - 1 <= 2);
  Json::CharReaderBuilder builder;
  Json::Value parsed;
  std::string errors;
  const auto reader = std::unique_ptr<Json::CharReader>(builder.newCharReader());
  REQUIRE(reader->parse(json.data(), json.data() + json.size(), &parsed, &errors));
  CHECK(parsed["duration_ms"].isNumeric());
  CHECK_EQ(parsed["duration_ms"].asDouble(), completion.durationMs);
}

TEST(WriteObservation_context_crosses_worker_and_marks_swallowed_exception_failed) {
  Recording recording;
  wm::WriteObservation request("journal.save", "journal", "rest");
  std::thread worker([&] {
    wm::WriteContext context(request);
    CHECK(wm::currentWriteRequestId() == request.requestId());
    wm::reportCurrentWriteFailure(std::logic_error("PRIVATE CONTENT"));
  });
  worker.join();
  request.finish();
  REQUIRE(recording.lines.size() == 1);
  REQUIRE(recording.reporter->issues.size() == 1);
  CHECK(recording.lines[0].outcome == "failed");
  CHECK(recording.reporter->issues[0]["tags"]["request_id"] == request.requestId());
  CHECK(wm::currentWriteRequestId().empty());
}

TEST(WriteObservation_injected_reporter_and_unknown_exception_are_safe) {
  Capture capture;
  wm::WriteObservation observation("tool.audit", "journal", "tool", "", &capture);
  observation.failUnknown();
  REQUIRE(capture.issues.size() == 1);
  CHECK(capture.issues[0]["exception"]["values"][0]["type"] == "UnknownException");
  CHECK(capture.issues[0]["tags"]["request_id"] == observation.requestId());
}

TEST(WriteObservation_wrapper_preserves_return_and_exception) {
  Recording recording;
  CHECK(wm::observeWrite("tool.backfill", "gym", "tool", [] { return 19; }) == 19);
  bool caught = false;
  try {
    wm::observeWrite("tool.audit", "gym", "tool", [] { throw std::invalid_argument("private"); });
  } catch (const std::invalid_argument& error) { caught = std::string(error.what()) == "private"; }
  CHECK(caught);
  REQUIRE(recording.lines.size() == 2);
  CHECK(recording.lines[0].outcome == "ok");
  CHECK(recording.lines[1].outcome == "failed");
}
