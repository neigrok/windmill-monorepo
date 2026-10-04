#include "platform/adapters/http/AuthApi.h"
#include "test/platform/AppleLinkingFixture.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {
struct FakeAppleCodeVerifier : AppleOAuthClient {
  std::shared_ptr<FakeAppleIdentityVerifier> verifier;
  explicit FakeAppleCodeVerifier(std::shared_ptr<FakeAppleIdentityVerifier> v)
      : AppleOAuthClient("", "", "", ""), verifier(std::move(v)) {}
  bool configured() const override { return verifier->configured(); }
  void exchangeCode(const std::string&, std::function<void(std::optional<ProviderIdentity>)> done) override {
    done(verifier->identity);
  }
};
struct HttpFixture : AppleLinkingFixture {
  std::shared_ptr<FakeAppleCodeVerifier> apple = std::make_shared<FakeAppleCodeVerifier>(verifier);
  AuthApi api{auth, nullptr, true, SessionCookieScopes{"windmill.works", "old.windmill.works"},
              nullptr, "", apple, verifier, {"https://windmill.works"}};
  drogon::HttpResponsePtr call(void (AuthApi::*method)(const drogon::HttpRequestPtr&, HttpCallback&&),
      const std::string& body = "{}", const std::string& session = "", bool bearer = false, const std::string& origin = "https://windmill.works",
      const std::string& contentType = "application/json") {
    const auto request = drogon::HttpRequest::newHttpRequest();
    request->addHeader("Content-Type", contentType);
    if (!origin.empty()) request->addHeader("Origin", origin);
    request->setBody(body);
    if (!session.empty()) {
      if (bearer) request->addHeader("Authorization", "Bearer " + session);
      else request->addCookie("wm_session", session);
    }
    drogon::HttpResponsePtr response;
    (api.*method)(request, [&](auto r) { response = std::move(r); });
    return response;
  }
  drogon::HttpResponsePtr start(bool native, const std::string& session = "", bool bearer = false) {
    return call(native ? &AuthApi::appleNative : &AuthApi::apple,
                R"({"identityToken":"token","nonce":"nonce","authorizationCode":"code","name":"Sam Gold"})",
                session, bearer);
  }
  drogon::HttpResponsePtr verify(const std::string& ticket, const std::string& code, bool bearer = true) {
    Json::Value body;
    body["email"] = "sam@example.com";
    body["code"] = code;
    body["appleTicket"] = ticket;
    if (bearer) body["sessionTransport"] = "bearer";
    return call(&AuthApi::verifyCode, Json::writeString(Json::StreamWriterBuilder{}, body));
  }
  drogon::HttpResponsePtr create(const std::string& ticket) {
    return call(&AuthApi::appleCreate, "{\"appleTicket\":\"" + ticket + "\"}");
  }
};
void noCookie(const drogon::HttpResponsePtr& r) {
  CHECK(r->getHeader("set-cookie").empty());
  CHECK(r->cookies().empty());
}
void refusal(const drogon::HttpResponsePtr& r, drogon::HttpStatusCode status, const std::string& code,
             const std::string& message, const std::string& detail = "") {
  CHECK_EQ(r->getStatusCode(), status);
  Json::Value expected(Json::objectValue);
  expected["error"] = message;
  expected["code"] = code;
  if (!detail.empty()) expected["detail"] = detail;
  REQUIRE(r->getJsonObject());
  CHECK_EQ(*r->getJsonObject(), expected);
  noCookie(r);
}
}

TEST(apple_both_http_doors_return_only_a_ticket_until_creation_for_every_new_address) {
  for (const bool native : {false, true}) for (const bool relay : {false, true}) {
    HttpFixture f;
    f.verifier->identity->email = Email{relay ? "relay@privaterelay.appleid.com" : "new@example.com"};
    f.verifier->identity->relayEmail = relay;
    const auto r = f.start(native);
    CHECK_EQ(r->getStatusCode(), drogon::k200OK);
    Json::Value expected(Json::objectValue);
    expected["appleTicket"] = "s1";
    expected["expiresAt"] = static_cast<Json::UInt64>(f.clock.now + AuthPolicy::appleTicketLifetimeMs);
    CHECK_EQ(*r->getJsonObject(), expected);
    noCookie(r);
    CHECK(f.repo.usersById.empty());
    CHECK(f.repo.sessions.empty());
    CHECK(f.repo.identities.empty());
    const auto created = f.create("s1");
    CHECK_EQ(created->getStatusCode(), drogon::k200OK);
    const auto body = *created->getJsonObject();
    CHECK_EQ(body.size(), Json::ArrayIndex{4});
    CHECK(body["created"].asBool());
    CHECK_EQ(body["privateEmail"].asBool(), relay);
    CHECK_EQ(body["user"]["name"].asString(), std::string("Sam Gold"));
    CHECK(created->getHeader("set-cookie").starts_with("wm_session=" + body["session"].asString() + ";"));
    CHECK(f.auth->authenticate(body["session"].asString()));
    refusal(f.create("s1"), drogon::k410Gone, "apple-ticket-expired", "Continue with Apple again",
            "Apple's sign-in lasts 15 minutes, and this one ran out. Nothing was created.");
  }
}

TEST(apple_both_doors_keep_matched_signin_body_and_accept_subject_only_bound_tokens) {
  for (const bool native : {false, true}) for (const bool bound : {false, true}) {
    HttpFixture f;
    const auto account = f.user(f.identity().email.value);
    if (bound) {
      f.repo.bindIdentity(Provider::apple, f.identity().subject, account.id, f.identity().email.value);
      f.verifier->identity->email = Email{""};
      f.verifier->identity->emailVerified = false;
    }
    const auto r = f.start(native);
    CHECK_EQ(r->getStatusCode(), drogon::k200OK);
    const auto body = *r->getJsonObject();
    CHECK_EQ(body.size(), Json::ArrayIndex{4});
    CHECK_EQ(body["user"]["id"].asString(), account.id.str());
    CHECK_EQ(body["user"]["name"].asString(), account.name);
    CHECK(!body["created"].asBool());
    CHECK(!body.isMember("appleTicket"));
    CHECK(!r->getHeader("set-cookie").empty());
    CHECK(f.repo.appleTickets.empty());
  }
}

TEST(apple_dead_ticket_contract_precedes_code_errors_and_missing_fields) {
  for (const int state : {0, 1, 2}) {
    HttpFixture f;
    auto ticket = f.ticket();
    const auto digits = f.code();
    if (state == 0) ticket = "unknown";
    if (state == 1) f.repo.spentAppleTickets.insert(f.tokens.digestOf(ticket));
    if (state == 2) f.clock.now += AuthPolicy::appleTicketLifetimeMs;
    for (const auto& r : {f.create(ticket), f.verify(ticket, digits), f.verify(ticket, "")})
      refusal(r, drogon::k410Gone, "apple-ticket-expired", "Continue with Apple again",
              "Apple's sign-in lasts 15 minutes, and this one ran out. Nothing was created.");
    for (const auto& [key, code] : f.repo.links) { CHECK(!code.consumedAt); CHECK_EQ(code.attempts, 0); }
  }
}

TEST(apple_code_refusals_collapse_and_no_account_keeps_ticket_available) {
  HttpFixture f;
  const auto ticket = f.ticket();
  const auto digits = f.code();
  refusal(f.verify(ticket, "000000"), drogon::k410Gone, "expired", "That code didn't work",
          "Check the digits, or send a fresh one.");
  refusal(f.verify(ticket, digits), drogon::k404NotFound, "no-account", "No account at this email");
  CHECK(f.repo.usersById.empty());
  CHECK(f.repo.identities.empty());
  CHECK(f.repo.sessions.empty());
  CHECK(f.repo.findAppleTicket(f.tokens.digestOf(ticket), f.clock.now));
  refusal(f.verify(ticket, digits), drogon::k410Gone, "expired", "That code didn't work",
          "Check the digits, or send a fresh one.");
  CHECK_EQ(f.create(ticket)->getStatusCode(), drogon::k200OK);
}

TEST(apple_code_attachment_success_adds_the_flag_with_cookie_and_optional_bearer_session) {
  for (const bool bearer : {false, true}) {
    HttpFixture f;
    const auto account = f.user();
    const auto ticket = f.ticket();
    const auto r = f.verify(ticket, f.code(), bearer);
    CHECK_EQ(r->getStatusCode(), drogon::k200OK);
    const auto body = *r->getJsonObject();
    CHECK_EQ(body.size(), Json::ArrayIndex{bearer ? 3u : 2u});
    CHECK(body["appleAttached"].asBool());
    CHECK_EQ(body["user"]["id"].asString(), account.id.str());
    CHECK_EQ(body.isMember("session"), bearer);
    CHECK(!r->getHeader("set-cookie").empty());
    CHECK(!f.repo.findAppleTicket(f.tokens.digestOf(ticket), f.clock.now));
  }
}

TEST(apple_subject_taken_during_question_returns_409_for_both_answers) {
  for (const bool create : {false, true}) {
    HttpFixture f;
    f.user();
    const auto ticket = f.ticket();
    const auto other = f.user("other@example.com");
    f.repo.bindIdentity(Provider::apple, f.identity().subject, other.id, f.identity().email.value);
    refusal(create ? f.create(ticket) : f.verify(ticket, f.code()), drogon::k409Conflict,
            "identity-taken", "that Apple ID already opens another account");
    CHECK(f.repo.sessions.empty());
    CHECK(f.repo.findUserById(other.id));
  }
}

TEST(apple_both_signedin_doors_attach_or_takeover_empty_accounts_and_refuse_data_accounts) {
  for (const bool native : {false, true}) for (const bool bearer : {false, true}) for (const int state : {0, 1, 2, 3}) {
    HttpFixture f;
    const auto mine = f.user();
    f.session(mine, "s-mine");
    std::optional<User> other;
    if (state == 1) f.repo.bindIdentity(Provider::apple, f.identity().subject, mine.id, f.identity().email.value);
    if (state >= 2) {
      other = f.user("other@example.com");
      f.session(*other, "s-other");
      f.repo.bindIdentity(Provider::apple, f.identity().subject, other->id, f.identity().email.value);
      if (state == 3) f.footprint.withData.insert(other->id.str());
    }
    const auto r = f.start(native, "s-mine", bearer);
    if (state == 3) {
      refusal(r, drogon::k409Conflict, "identity-taken", "that Apple ID already opens another account");
      CHECK(f.repo.findUserById(other->id));
      CHECK(f.repo.findSession(f.tokens.digestOf("s-other")));
    } else {
      CHECK_EQ(r->getStatusCode(), drogon::k200OK);
      const auto body = *r->getJsonObject();
      CHECK_EQ(body.size(), Json::ArrayIndex{2});
      CHECK(body["attached"].asBool());
      CHECK_EQ(body["user"]["id"].asString(), mine.id.str());
      noCookie(r);
      if (other) {
        CHECK(!f.repo.findUserById(other->id));
        CHECK_EQ(f.revocations.digests, (std::vector<std::string>{f.tokens.digestOf("s-other")}));
      }
    }
  }
}

TEST(apple_me_lists_link_metadata_and_remove_only_unbinds_callers_apple_door) {
  HttpFixture f;
  const auto mine = f.user();
  const auto other = f.user("other@example.com");
  f.session(mine, "s-mine");
  f.repo.tryBindIdentity(f.identity(), mine.id);
  f.repo.bindIdentity(Provider::apple, "other-subject", other.id, "other-relay@privaterelay.appleid.com");
  const auto me = f.call(&AuthApi::me, "{}", "s-mine", true);
  Json::Value expected(Json::arrayValue), email, apple;
  email["kind"] = "email"; email["email"] = mine.email.value;
  apple["kind"] = "apple"; apple["email"] = f.identity().email.value; apple["relay"] = true;
  expected.append(email); expected.append(apple);
  CHECK_EQ((*me->getJsonObject())["signInMethods"], expected);
  const auto removed = f.call(&AuthApi::removeApple, "{}", "s-mine");
  CHECK_EQ(removed->getStatusCode(), drogon::k204NoContent);
  noCookie(removed);
  CHECK(f.auth->authenticate("s-mine"));
  CHECK(f.repo.findUserById(mine.id));
  CHECK(f.repo.findIdentity(Provider::apple, "other-subject"));
  CHECK_EQ(f.call(&AuthApi::removeApple, "{}", "s-mine")->getStatusCode(), drogon::k404NotFound);
  CHECK_EQ(f.call(&AuthApi::removeApple)->getStatusCode(), drogon::k401Unauthorized);
  const auto remaining = *f.call(&AuthApi::me, "{}", "s-mine")->getJsonObject();
  REQUIRE_EQ(remaining["signInMethods"].size(), Json::ArrayIndex{1});
  CHECK_EQ(remaining["signInMethods"][0], email);
}

TEST(apple_invalid_or_unbound_subject_only_tokens_are_refused_by_both_http_doors) {
  for (const bool native : {false, true}) for (const int state : {0, 1, 2}) {
    HttpFixture f;
    if (state == 0) f.verifier->identity = std::nullopt;
    if (state == 1) f.verifier->identity->emailVerified = false;
    if (state == 2) f.verifier->identity->email = Email{""};
    const auto r = f.start(native);
    CHECK_EQ(r->getStatusCode(), drogon::k401Unauthorized);
    noCookie(r);
    CHECK(f.repo.usersById.empty());
    CHECK(f.repo.appleTickets.empty());
  }
}

TEST(apple_mutations_refuse_same_site_untrusted_origins_and_json_disguised_as_text_before_writes) {
  for (const auto method : {&AuthApi::apple, &AuthApi::appleNative, &AuthApi::appleCreate,
                            &AuthApi::verifyCode, &AuthApi::removeApple}) {
    for (const int attack : {0, 1, 2}) {
      const bool hostileOrigin = attack != 1;
      HttpFixture f;
      const auto mine = f.user();
      f.session(mine, "victim-session");
      const auto ticket = f.ticket();
      const auto code = f.code();
      if (method == &AuthApi::removeApple) f.repo.tryBindIdentity(f.identity(), mine.id);
      const auto identities = f.repo.identities;
      const auto before = f.repo.sessions.size();
      const std::string body = "{\"authorizationCode\":\"attacker\",\"identityToken\":\"attacker\",\"nonce\":\"nonce\","
          "\"appleTicket\":\"" + ticket + "\",\"email\":\"sam@example.com\",\"code\":\"" + code + "\"}";
      const auto response = f.call(method, body, "victim-session", false,
          hostileOrigin ? "https://hostile.windmill.works" : "https://windmill.works",
          attack == 2 ? "application/json" : "text/plain; x=application/json");
      refusal(response, hostileOrigin ? drogon::k403Forbidden : drogon::k415UnsupportedMediaType,
          hostileOrigin ? "untrusted-origin" : "unsupported-media-type",
          hostileOrigin ? "untrusted origin" : "application/json required");
      CHECK_EQ(f.repo.sessions.size(), before);
      CHECK_EQ(f.repo.identities, identities);
      CHECK(f.repo.findAppleTicket(f.tokens.digestOf(ticket), f.clock.now));
      for (const auto& [key, row] : f.repo.links) { CHECK(!row.consumedAt); CHECK_EQ(row.attempts, 0); }
    }
  }
}

TEST(apple_mutations_accept_json_essence_parameters_and_native_bearer_without_origin_or_cookies) {
  HttpFixture f;
  const auto mine = f.user();
  f.session(mine, "native-session");
  const auto attached = f.call(&AuthApi::appleNative, R"({"identityToken":"token","nonce":"nonce"})",
      "native-session", true, "", "application/json; charset=utf-8");
  CHECK_EQ(attached->getStatusCode(), drogon::k200OK);
  CHECK((*attached->getJsonObject())["attached"].asBool());
  CHECK_EQ(f.call(&AuthApi::removeApple, "", "native-session", true, "", "")->getStatusCode(), drogon::k204NoContent);
  CHECK_EQ(f.call(&AuthApi::appleNative, R"({"identityToken":"token","nonce":"nonce"})",
      "native-session", false, "")->getStatusCode(), drogon::k403Forbidden);
}

TEST(apple_guard_preserves_the_existing_native_cookie_code_door_without_a_ticket) {
  HttpFixture f;
  const auto mine = f.user();
  f.session(mine, "android-session");
  const auto response = f.call(&AuthApi::verifyCode,
      "{\"email\":\"sam@example.com\",\"code\":\"" + f.code() + "\"}", "android-session", false, "");
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ((*response->getJsonObject())["user"]["id"].asString(), mine.id.str());
}
