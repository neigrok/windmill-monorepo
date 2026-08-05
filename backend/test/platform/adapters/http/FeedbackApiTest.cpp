#include "platform/adapters/http/FeedbackApi.h"

#include "platform/adapters/json/JsonText.h"
#include "test/platform/Fakes.h"
#include "test/testing.h"

#include <optional>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

struct FakeFeedbackRepository : FeedbackRepository {
  struct Row {
    std::string sessionKey;
    std::optional<UserId> user;
    std::string message;
    std::string email;
    std::string context;
  };
  std::vector<Row> rows;

  void insert(const std::string& sessionKey, const std::optional<UserId>& user,
              const std::string& message, const std::string& email,
              const std::string& context) override {
    rows.push_back(Row{sessionKey, user, message, email, context});
  }
};

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");
  std::shared_ptr<FakeFeedbackRepository> repo = std::make_shared<FakeFeedbackRepository>();
  FeedbackApi api{repo, auth};

  UserId signIn(const std::string& sessionSecret) {
    User user = authRepo.createUser(Email{"sam@example.com"}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "", clock.now);
    return user.id;
  }
};

drogon::HttpRequestPtr post(const Json::Value& body) {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Post);
  request->setPath("/v1/feedback");
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  return request;
}

drogon::HttpResponsePtr send(FeedbackApi& api, const drogon::HttpRequestPtr& request) {
  drogon::HttpResponsePtr captured;
  api.submit(request, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

Json::Value note(const std::string& message) {
  Json::Value body(Json::objectValue);
  body["message"] = message;
  return body;
}

Json::Value bodyOf(const drogon::HttpResponsePtr& response) { return *response->getJsonObject(); }

}

TEST(feedback_a_valid_note_is_accepted_and_stored_trimmed) {
  Harness h;

  drogon::HttpResponsePtr response = send(h.api, post(note("   the tree is beautiful  ")));

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  CHECK_EQ(dump(bodyOf(response)), std::string(R"({"ok":true})"));
  REQUIRE_EQ(h.repo->rows.size(), 1u);
  const FakeFeedbackRepository::Row& stored = h.repo->rows[0];
  CHECK_EQ(stored.message, std::string("the tree is beautiful"));
  CHECK_EQ(stored.sessionKey, std::string(""));
  CHECK_EQ(stored.email, std::string(""));
  CHECK_EQ(stored.context, std::string(""));
  CHECK(stored.user == std::nullopt);
}

TEST(feedback_email_and_context_are_carried_and_the_session_key_when_well_formed) {
  Harness h;
  Json::Value body = note("bug on the map");
  body["email"] = "sam@example.com";
  body["context"] = "#/demo";
  body["sessionKey"] = "browser-abc_1";

  drogon::HttpResponsePtr response = send(h.api, post(body));

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  REQUIRE_EQ(h.repo->rows.size(), 1u);
  const FakeFeedbackRepository::Row& stored = h.repo->rows[0];
  CHECK_EQ(stored.message, std::string("bug on the map"));
  CHECK_EQ(stored.email, std::string("sam@example.com"));
  CHECK_EQ(stored.context, std::string("#/demo"));
  CHECK_EQ(stored.sessionKey, std::string("browser-abc_1"));
}

TEST(feedback_over_length_email_and_context_are_truncated_not_rejected) {
  Harness h;
  Json::Value body = note("all good");
  body["email"] = std::string(250, 'a');
  body["context"] = std::string(250, 'b');

  drogon::HttpResponsePtr response = send(h.api, post(body));

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  REQUIRE_EQ(h.repo->rows.size(), 1u);
  const FakeFeedbackRepository::Row& stored = h.repo->rows[0];
  CHECK_EQ(stored.email, std::string(200, 'a'));
  CHECK_EQ(stored.context, std::string(200, 'b'));
}

TEST(feedback_a_malformed_session_key_is_dropped_to_empty_not_rejected) {
  Harness h;
  Json::Value body = note("note");
  body["sessionKey"] = "not a valid key!";

  drogon::HttpResponsePtr response = send(h.api, post(body));

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  REQUIRE_EQ(h.repo->rows.size(), 1u);
  CHECK_EQ(h.repo->rows[0].sessionKey, std::string(""));
}

TEST(feedback_a_two_thousand_char_message_is_accepted_at_the_boundary) {
  Harness h;

  drogon::HttpResponsePtr response = send(h.api, post(note(std::string(2000, 'x'))));

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  REQUIRE_EQ(h.repo->rows.size(), 1u);
  CHECK_EQ(h.repo->rows[0].message, std::string(2000, 'x'));
}

TEST(feedback_an_over_length_message_is_rejected_whole_with_400) {
  Harness h;

  drogon::HttpResponsePtr response = send(h.api, post(note(std::string(2001, 'x'))));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(h.repo->rows.size(), 0u);
}

TEST(feedback_a_missing_or_empty_message_is_rejected_whole_with_400) {
  Harness h;

  CHECK_EQ(send(h.api, post(Json::Value(Json::objectValue)))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(send(h.api, post(note("")))->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(send(h.api, post(note("   \t\n  ")))->getStatusCode(), drogon::k400BadRequest);

  Json::Value numeric(Json::objectValue);
  numeric["message"] = 42;
  CHECK_EQ(send(h.api, post(numeric))->getStatusCode(), drogon::k400BadRequest);

  auto rawText = drogon::HttpRequest::newHttpRequest();
  rawText->setMethod(drogon::Post);
  rawText->setPath("/v1/feedback");
  rawText->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  rawText->setBody("not json at all");
  CHECK_EQ(send(h.api, rawText)->getStatusCode(), drogon::k400BadRequest);

  CHECK_EQ(h.repo->rows.size(), 0u);
}

TEST(feedback_an_anonymous_caller_is_stored_without_a_user) {
  Harness h;

  drogon::HttpResponsePtr response = send(h.api, post(note("ghost feedback")));

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  REQUIRE_EQ(h.repo->rows.size(), 1u);
  CHECK(h.repo->rows[0].user == std::nullopt);
}

TEST(feedback_an_authenticated_caller_is_attributed_from_the_session_not_the_body) {
  Harness h;
  UserId user = h.signIn("s-live");
  Json::Value body = note("signed-in feedback");
  body["userId"] = "forged-identity";

  drogon::HttpRequestPtr request = post(body);
  request->addHeader("authorization", "Bearer s-live");
  drogon::HttpResponsePtr response = send(h.api, request);

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  REQUIRE_EQ(h.repo->rows.size(), 1u);
  CHECK(h.repo->rows[0].user == std::optional<UserId>(user));
}

TEST(feedback_a_session_cookie_attributes_like_bearer) {
  Harness h;
  UserId user = h.signIn("s-cookie");

  drogon::HttpRequestPtr request = post(note("cookie feedback"));
  request->addCookie("wm_session", "s-cookie");
  drogon::HttpResponsePtr response = send(h.api, request);

  CHECK_EQ(response->getStatusCode(), drogon::k202Accepted);
  REQUIRE_EQ(h.repo->rows.size(), 1u);
  CHECK(h.repo->rows[0].user == std::optional<UserId>(user));
}
