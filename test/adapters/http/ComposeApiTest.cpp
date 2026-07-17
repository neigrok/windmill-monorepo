#include "adapters/http/ComposeApi.h"

#include "adapters/json/TreeJson.h"
#include "test/testing.h"

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

  bool configured() const override { return hasKey; }
  void compose(const std::string& text,
               std::function<void(std::optional<std::string>)> done) override {
    composed.push_back(text);
    done(reply);
  }
};

struct Harness {
  std::shared_ptr<FakePlanComposer> composer = std::make_shared<FakePlanComposer>();
  ComposeApi api{composer};
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

drogon::HttpResponsePtr send(ComposeApi& api, const drogon::HttpRequestPtr& request) {
  drogon::HttpResponsePtr captured;
  api.compose(request, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

std::string bodyOf(const drogon::HttpResponsePtr& response) {
  return dump(*response->getJsonObject());
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

TEST(compose_text_over_10240_bytes_is_400_too_long) {
  Harness h;
  drogon::HttpResponsePtr response = send(h.api, postText(std::string(10241, 'a')));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(bodyOf(response), std::string(R"({"code":"too-long"})"));
  CHECK_EQ(h.composer->composed.size(), 0u);
}

TEST(compose_text_at_exactly_10240_bytes_passes_the_cap) {
  Harness h;
  h.composer->reply = "# Plan";
  drogon::HttpResponsePtr response = send(h.api, postText(std::string(10240, 'a')));

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
  CHECK_EQ(h.composer->composed.size(), 1u);
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
  CHECK_EQ(h.composer->composed.size(), 1u);
  CHECK_EQ(h.composer->composed[0], std::string("i want to learn to sail. already read the theory"));
}
