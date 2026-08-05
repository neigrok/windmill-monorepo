#include "products/roadmap/adapters/http/ComposeApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "test/testing.h"

#include <trantor/net/AsyncStream.h>

#include <cstdlib>
#include <memory>
#include <optional>
#include <string>
#include <vector>

using namespace wm;

namespace {

struct FakePlanComposer : PlanComposer {
  bool hasKey = true;
  std::optional<std::string> reply;
  std::vector<std::string> composed;
  std::vector<std::string> deltas;
  bool streamOk = true;
  std::vector<std::string> streamed;
  int cancels = 0;

  bool configured() const override { return hasKey; }
  void compose(const std::string& text,
               std::function<void(std::optional<std::string>)> done) override {
    composed.push_back(text);
    done(reply);
  }
  std::function<void()> composeStream(const std::string& text,
                                      std::function<void(const std::string&)> onDelta,
                                      std::function<void(bool)> onDone) override {
    streamed.push_back(text);
    for (const std::string& delta : deltas) onDelta(delta);
    onDone(streamOk);
    return [this]() { ++cancels; };
  }
};

struct Harness {
  std::shared_ptr<FakePlanComposer> composer = std::make_shared<FakePlanComposer>();
  ComposeApi api{composer};
};

// The wire record outlives the stream on purpose: ResponseStream::close() destroys the
// AsyncStream it owns, so the observations must live with the test, not the stream.
struct WireLog {
  std::string sent;
  bool closed = false;
};

struct RecordingAsyncStream : trantor::AsyncStream {
  explicit RecordingAsyncStream(WireLog& log) : log_(log) {}

  bool send(const char* data, size_t length) override {
    log_.sent.append(data, length);
    return true;
  }
  void close() override { log_.closed = true; }

private:
  WireLog& log_;
};

drogon::HttpRequestPtr post(const std::string& body) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Post);
  request->setPath("/v1/compose");
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(body);
  return request;
}

drogon::HttpRequestPtr postText(const std::string& text) {
  Json::Value body(Json::objectValue);
  body["text"] = text;
  return post(dump(body));
}

drogon::HttpRequestPtr postStreamText(const std::string& text) {
  Json::Value body(Json::objectValue);
  body["text"] = text;
  body["stream"] = true;
  return post(dump(body));
}

drogon::HttpResponsePtr send(ComposeApi& api, const drogon::HttpRequestPtr& request) {
  drogon::HttpResponsePtr captured;
  api.compose(request, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

std::string bodyOf(const drogon::HttpResponsePtr& response) {
  return dump(*response->getJsonObject());
}

// Hands the streaming response its wire — the fake stands in for the connection drogon
// would attach — and everything sent lands in the given log.
void attachWire(const drogon::HttpResponsePtr& response, WireLog& log) {
  response->asyncStreamCallback()(
      std::make_unique<drogon::ResponseStream>(std::make_unique<RecordingAsyncStream>(log)));
}

std::string dechunked(const std::string& wire) {
  std::string out;
  std::size_t at = 0;
  while (at < wire.size()) {
    const std::size_t lineEnd = wire.find("\r\n", at);
    if (lineEnd == std::string::npos) break;
    const std::size_t size = std::strtoul(wire.c_str() + at, nullptr, 16);
    at = lineEnd + 2;
    if (size == 0) break;
    out += wire.substr(at, size);
    at += size + 2;
  }
  return out;
}

}

TEST(compose_missing_or_blank_text_is_400_empty) {
  Harness h;

  drogon::HttpResponsePtr notJson = send(h.api, post("not json at all"));
  CHECK_EQ(notJson->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(notJson), std::string(R"({"code":"empty"})"));

  drogon::HttpResponsePtr noText = send(h.api, post("{}"));
  CHECK_EQ(noText->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(noText), std::string(R"({"code":"empty"})"));

  drogon::HttpResponsePtr wrongType = send(h.api, post(R"({"text": 42})"));
  CHECK_EQ(wrongType->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(wrongType), std::string(R"({"code":"empty"})"));

  drogon::HttpResponsePtr arrayBody = send(h.api, post(R"([{"text": "learn to sail"}])"));
  CHECK_EQ(arrayBody->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(arrayBody), std::string(R"({"code":"empty"})"));

  drogon::HttpResponsePtr blank = send(h.api, postText("  \t\r\n  "));
  CHECK_EQ(blank->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(blank), std::string(R"({"code":"empty"})"));

  CHECK_EQ(h.composer->composed.size(), 0u);
}

TEST(compose_text_over_the_cap_is_400_too_long) {
  Harness h;
  drogon::HttpResponsePtr response = send(h.api, postText(std::string(24577, 'a')));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(response), std::string(R"({"code":"too-long"})"));
  CHECK_EQ(h.composer->composed.size(), 0u);
}

TEST(compose_text_at_exactly_the_cap_passes) {
  Harness h;
  h.composer->reply = "# Plan";
  drogon::HttpResponsePtr response = send(h.api, postText(std::string(24576, 'a')));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response), std::string(R"({"plan":"# Plan"})"));
  CHECK_EQ(h.composer->composed.size(), 1u);
}

TEST(compose_without_an_api_key_is_503_unavailable_and_never_calls_upstream) {
  Harness h;
  h.composer->hasKey = false;
  drogon::HttpResponsePtr response = send(h.api, postText("learn to sail"));

  CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(bodyOf(response), std::string(R"({"code":"compose-unavailable"})"));
  CHECK_EQ(h.composer->composed.size(), 0u);
}

TEST(compose_upstream_failure_is_502_compose_failed) {
  Harness h;
  h.composer->reply = std::nullopt;
  drogon::HttpResponsePtr response = send(h.api, postText("learn to sail"));

  CHECK_EQ(response->getStatusCode(), drogon::k502BadGateway);
  CHECK_EQ(bodyOf(response), std::string(R"({"code":"compose-failed"})"));
  REQUIRE_EQ(h.composer->composed.size(), 1u);
  CHECK_EQ(h.composer->composed[0], std::string("learn to sail"));
}

TEST(compose_happy_path_returns_the_plan_verbatim) {
  Harness h;
  h.composer->reply = "# Learn to sail\n\n## Basics\n- [x] Read the theory\n1. Rig the boat\n  2. Leave the harbour";
  drogon::HttpResponsePtr response = send(h.api, postText("i want to learn to sail. already read the theory"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  Json::Value body = *response->getJsonObject();
  CHECK_EQ(body["plan"].asString(),
           std::string("# Learn to sail\n\n## Basics\n- [x] Read the theory\n1. Rig the boat\n  2. Leave the harbour"));
  CHECK_EQ(body.size(), 1u);
  REQUIRE_EQ(h.composer->composed.size(), 1u);
  CHECK_EQ(h.composer->composed[0], std::string("i want to learn to sail. already read the theory"));
}

TEST(compose_with_stream_false_stays_on_the_buffered_path) {
  Harness h;
  h.composer->reply = "# Plan";
  Json::Value body(Json::objectValue);
  body["text"] = "learn to sail";
  body["stream"] = false;
  drogon::HttpResponsePtr response = send(h.api, post(dump(body)));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(bodyOf(response), std::string(R"({"plan":"# Plan"})"));
  CHECK_EQ(h.composer->composed.size(), 1u);
  CHECK_EQ(h.composer->streamed.size(), 0u);
}

TEST(compose_stream_happy_path_frames_each_delta_then_done) {
  Harness h;
  h.composer->deltas = {"# Learn to sail\n", "- Rig", " the boat"};
  drogon::HttpResponsePtr response = send(h.api, postStreamText("i want to learn to sail"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(response->contentTypeString(), std::string("text/event-stream"));
  CHECK_EQ(response->getHeader("cache-control"), std::string("no-cache"));
  CHECK_EQ(response->getHeader("x-accel-buffering"), std::string("no"));

  WireLog wire;
  attachWire(response, wire);
  CHECK_EQ(dechunked(wire.sent),
           std::string("event: delta\ndata: {\"text\":\"# Learn to sail\\n\"}\n\n"
                       "event: delta\ndata: {\"text\":\"- Rig\"}\n\n"
                       "event: delta\ndata: {\"text\":\" the boat\"}\n\n"
                       "event: done\ndata: {}\n\n"));
  CHECK(wire.closed);
  REQUIRE_EQ(h.composer->streamed.size(), 1u);
  CHECK_EQ(h.composer->streamed[0], std::string("i want to learn to sail"));
  CHECK_EQ(h.composer->composed.size(), 0u);
  CHECK_EQ(h.composer->cancels, 0);
}

TEST(compose_stream_upstream_failure_before_any_delta_is_a_fail_event) {
  Harness h;
  h.composer->streamOk = false;
  drogon::HttpResponsePtr response = send(h.api, postStreamText("learn to sail"));

  WireLog wire;
  attachWire(response, wire);
  CHECK_EQ(dechunked(wire.sent),
           std::string("event: fail\ndata: {\"code\":\"compose-failed\"}\n\n"));
  CHECK(wire.closed);
}

TEST(compose_stream_mid_stream_failure_fails_after_the_deltas_already_sent) {
  Harness h;
  h.composer->deltas = {"# Learn to sail\n", "- Rig"};
  h.composer->streamOk = false;
  drogon::HttpResponsePtr response = send(h.api, postStreamText("learn to sail"));

  WireLog wire;
  attachWire(response, wire);
  CHECK_EQ(dechunked(wire.sent),
           std::string("event: delta\ndata: {\"text\":\"# Learn to sail\\n\"}\n\n"
                       "event: delta\ndata: {\"text\":\"- Rig\"}\n\n"
                       "event: fail\ndata: {\"code\":\"compose-failed\"}\n\n"));
  CHECK(wire.closed);
}

TEST(compose_stream_keeps_the_json_guards_ahead_of_the_stream) {
  Harness h;

  drogon::HttpResponsePtr blank = send(h.api, postStreamText("  \t\r\n  "));
  CHECK_EQ(blank->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(blank), std::string(R"({"code":"empty"})"));

  drogon::HttpResponsePtr tooLong = send(h.api, postStreamText(std::string(24577, 'a')));
  CHECK_EQ(tooLong->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(tooLong), std::string(R"({"code":"too-long"})"));

  h.composer->hasKey = false;
  drogon::HttpResponsePtr unavailable = send(h.api, postStreamText("learn to sail"));
  CHECK_EQ(unavailable->getStatusCode(), drogon::k503ServiceUnavailable);
  CHECK_EQ(bodyOf(unavailable), std::string(R"({"code":"compose-unavailable"})"));

  CHECK_EQ(h.composer->streamed.size(), 0u);
  CHECK_EQ(h.composer->composed.size(), 0u);
}
