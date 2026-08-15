#include "products/journal/adapters/http/NudgeApi.h"

#include "platform/adapters/json/JsonText.h"
#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>

using namespace wm;
using namespace wm::fake;

namespace {

constexpr std::uint64_t kWeekMs = 7ULL * 24 * 60 * 60 * 1000;

// The same harness JournalApiTest runs on, plus the nudge half: the fake repository, a REAL
// NudgeSweep over the fakes (dark by default — arming off), and the api under test. The first
// user the auth fake mints is "u1".
struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;           // the platform sign-in mailer AuthService still speaks to
  FakeNudgeMail nudgeMail;   // the journal nudge mailer the sweep now speaks to
  std::shared_ptr<FakeTokens> tokens = std::make_shared<FakeTokens>();
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, *tokens, *clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, *tokens, *clock, oauth, footprint, "https://windmill.works");
  std::shared_ptr<FakeNudgeRepository> nudges = std::make_shared<FakeNudgeRepository>();
  std::shared_ptr<NudgeSweep> sweep;
  std::shared_ptr<NudgeApi> api;

  explicit Harness(NudgeArming arming = NudgeArming(), std::string adminToken = "")
      : sweep(std::make_shared<NudgeSweep>(*nudges, nudgeMail, *tokens, *clock, std::move(arming),
                                           "https://windmill.works")),
        api(std::make_shared<NudgeApi>(nudges, sweep, auth, tokens, clock, std::move(adminToken))) {}

  UserId signIn(const std::string& sessionSecret) {
    User user = authRepo.createUser(Email{"sam@example.com"}, "sam");
    authRepo.insertSession(tokens->digestOf(sessionSecret), user.id, clock->now + 1'000'000, "", "",
                           clock->now);
    return user.id;
  }
};

drogon::HttpRequestPtr request(drogon::HttpMethod method, const std::string& path,
                               const std::string& body = "", const std::string& session = "") {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(method);
  req->setPath(path);
  if (!body.empty()) {
    req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    req->setBody(body);
  }
  if (!session.empty()) req->addCookie("wm_session", session);
  return req;
}

drogon::HttpResponsePtr getSettings(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->getSettings(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

drogon::HttpResponsePtr patchSettings(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->patchSettings(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

drogon::HttpResponsePtr pause(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->pause(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

drogon::HttpResponsePtr unsubscribe(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->unsubscribe(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

drogon::HttpResponsePtr adminSweep(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->adminSweep(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

// A user whose nudges are on, with a device-pushed schedule and a live pause secret — the state
// every mail-borne door (pause, unsubscribe) starts from.
UserId enrolled(Harness& h, const std::string& pauseSecret) {
  UserId me = h.signIn("s-live");
  NudgeSettings on;
  on.enabled = true;
  on.nextDueAtMs = h.clock->now + 3'600'000;
  on.slotDay = ld("2026-07-28");
  h.nudges->upsertSettings(me, on);
  h.nudges->setPauseDigest(me, h.tokens->digestOf(pauseSecret));
  return me;
}

}

TEST(nudge_get_without_a_session_is_401) {
  Harness h;

  drogon::HttpResponsePtr response = getSettings(h, request(drogon::Get, "/v1/journal/nudge"));

  CHECK_EQ(response->getStatusCode(), drogon::k401Unauthorized);
  CHECK_EQ(dump(*response->getJsonObject()), std::string(R"({"error":"sign in to read your nudge"})"));
}

TEST(nudge_get_without_a_row_answers_the_defaults) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      getSettings(h, request(drogon::Get, "/v1/journal/nudge", "", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string(R"({"adaptive":false,"armed":false,"channel":"email","enabled":false,)"
                       R"("suppressed":false})"));
}

TEST(nudge_patch_turns_on_and_stores_the_device_schedule) {
  Harness h(NudgeArming(true, "u1"));
  UserId me = h.signIn("s-live");
  Json::Value body(Json::objectValue);
  body["enabled"] = true;
  body["nextDueAt"] = Json::Value::UInt64(1'700'000'900'000ULL);
  body["slotDay"] = "2026-07-28";

  drogon::HttpResponsePtr response =
      patchSettings(h, request(drogon::Patch, "/v1/journal/nudge", dump(body), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string(R"({"adaptive":true,"armed":true,"channel":"email",)"
                       R"("enabled":true,"nextDueAt":1700000900000,"suppressed":false})"));
  std::optional<NudgeSettings> stored = h.nudges->settingsFor(me);
  REQUIRE(stored.has_value());
  CHECK(stored->enabled);
  CHECK_EQ(stored->channel, std::string("email"));
  CHECK(stored->nextDueAtMs == std::optional<std::uint64_t>(1'700'000'900'000ULL));
  CHECK(stored->slotDay == std::optional<LocalDate>(ld("2026-07-28")));
  CHECK(stored->pausedUntilMs == std::optional<std::uint64_t>());
  CHECK_FALSE(stored->suppressed);
}

// The gate the web enforced by not mounting the panel, enforced where an API key can reach: an
// account the dark-launch allowlist does not name cannot store a row that says "on".
TEST(nudge_patch_enabling_outside_the_allowlist_is_403_and_stores_nothing) {
  Harness h;
  UserId me = h.signIn("s-live");
  Json::Value body(Json::objectValue);
  body["enabled"] = true;

  drogon::HttpResponsePtr response =
      patchSettings(h, request(drogon::Patch, "/v1/journal/nudge", dump(body), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string(R"({"error":"nudges aren't switched on for this account yet"})"));
  CHECK_FALSE(h.nudges->settingsFor(me).has_value());
}

// Switching OFF is never gated — a refusal there would pin a row on for someone we cannot reach.
TEST(nudge_patch_disabling_outside_the_allowlist_still_lands) {
  Harness h;
  UserId me = h.signIn("s-live");
  NudgeSettings on;
  on.enabled = true;
  h.nudges->upsertSettings(me, on);
  Json::Value body(Json::objectValue);
  body["enabled"] = false;

  drogon::HttpResponsePtr response =
      patchSettings(h, request(drogon::Patch, "/v1/journal/nudge", dump(body), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  REQUIRE(h.nudges->settingsFor(me).has_value());
  CHECK_FALSE(h.nudges->settingsFor(me)->enabled);
}

TEST(nudge_patch_with_a_malformed_slot_day_is_400_and_stores_nothing) {
  Harness h;
  UserId me = h.signIn("s-live");
  Json::Value body(Json::objectValue);
  body["enabled"] = true;
  body["slotDay"] = "28-07-2026";

  drogon::HttpResponsePtr response =
      patchSettings(h, request(drogon::Patch, "/v1/journal/nudge", dump(body), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(dump(*response->getJsonObject()), std::string(R"({"error":"slotDay must be YYYY-MM-DD"})"));
  CHECK_FALSE(h.nudges->settingsFor(me).has_value());
}

TEST(nudge_pause_with_a_matching_secret_pauses_for_a_week) {
  Harness h;
  UserId me = enrolled(h, "p-mail");
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/journal/nudge/pause");
  req->addHeader("authorization", "Bearer p-mail");

  drogon::HttpResponsePtr response = pause(h, req);

  CHECK_EQ(response->getStatusCode(), drogon::k204NoContent);
  std::optional<NudgeSettings> stored = h.nudges->settingsFor(me);
  REQUIRE(stored.has_value());
  CHECK(stored->enabled);
  CHECK(stored->pausedUntilMs == std::optional<std::uint64_t>(h.clock->now + kWeekMs));
}

TEST(nudge_pause_with_a_stranger_secret_is_still_204_and_changes_nothing) {
  Harness h;
  UserId me = enrolled(h, "p-mail");
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/journal/nudge/pause");
  req->addHeader("authorization", "Bearer p-wrong");

  drogon::HttpResponsePtr response = pause(h, req);

  // The same 204 whether or not the secret matched — this door is no oracle for whose nudges exist.
  CHECK_EQ(response->getStatusCode(), drogon::k204NoContent);
  std::optional<NudgeSettings> stored = h.nudges->settingsFor(me);
  REQUIRE(stored.has_value());
  CHECK(stored->enabled);
  CHECK(stored->pausedUntilMs == std::optional<std::uint64_t>());
}

TEST(nudge_unsubscribe_with_a_matching_secret_disables) {
  Harness h;
  UserId me = enrolled(h, "p-mail");
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/journal/nudge/unsubscribe");
  req->setParameter("t", "p-mail");

  drogon::HttpResponsePtr response = unsubscribe(h, req);

  CHECK_EQ(response->getStatusCode(), drogon::k204NoContent);
  std::optional<NudgeSettings> stored = h.nudges->settingsFor(me);
  REQUIRE(stored.has_value());
  CHECK_FALSE(stored->enabled);
}

TEST(admin_sweep_with_no_token_configured_is_403) {
  Harness h;

  drogon::HttpResponsePtr response =
      adminSweep(h, request(drogon::Post, "/v1/admin/journal/nudge/sweep"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
}

TEST(admin_sweep_with_the_wrong_token_is_403) {
  Harness h(NudgeArming(), "the-secret");
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/admin/journal/nudge/sweep");
  req->addHeader("x-admin-token", "the-secre");

  drogon::HttpResponsePtr response = adminSweep(h, req);

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(dump(*response->getJsonObject()), std::string(R"({"error":"admin token required"})"));
}

TEST(admin_sweep_with_the_right_token_reports) {
  Harness h(NudgeArming(), "the-secret");
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/admin/journal/nudge/sweep");
  req->addHeader("x-admin-token", "the-secret");

  drogon::HttpResponsePtr response = adminSweep(h, req);

  // Nobody is due over an empty repository, so the report is all zeros — the door and the shape
  // are what this case pins down.
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string(R"({"failed":0,"held":0,"sent":0,"skipped":0})"));
}

TEST(nudge_get_reports_a_mailbox_the_provider_called_dead) {
  // The one fact on this surface the reader did not choose. Someone whose nudges silently stopped
  // is owed the reason: a settings page answering `enabled: true` while nothing ever arrives is
  // lying to them, and the flag is the only thing that can tell them the truth.
  Harness h;
  UserId me = h.signIn("s-live");
  NudgeSettings on;
  on.enabled = true;
  on.nextDueAtMs = h.clock->now + 3'600'000;
  on.slotDay = ld("2026-07-28");
  h.nudges->upsertSettings(me, on);
  h.nudges->emails[me.str()] = Email{"sam@example.com"};

  CHECK(h.nudges->stopMailing(Email{"sam@example.com"}));

  drogon::HttpResponsePtr response =
      getSettings(h, request(drogon::Get, "/v1/journal/nudge", "", "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string(R"({"adaptive":true,"armed":false,"channel":"email","enabled":true,)"
                       R"("nextDueAt":1700003600000,"suppressed":true})"));
  // Switching off does not lift it: the flag is the provider's fact, not a preference, so what
  // its owner asked for survives beside it rather than instead of it — and only the owner turning
  // the nudge back ON says the mailbox works again.
  Json::Value patch(Json::objectValue);
  patch["enabled"] = false;
  drogon::HttpResponsePtr off =
      patchSettings(h, request(drogon::Patch, "/v1/journal/nudge", dump(patch), "s-live"));
  CHECK_EQ(off->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*off->getJsonObject()),
           std::string(R"({"adaptive":true,"armed":true,"channel":"email","enabled":false,)"
                       R"("nextDueAt":1700003600000,"suppressed":true})"));
  CHECK(h.nudges->settingsFor(me)->suppressed);
  CHECK_FALSE(h.nudges->settingsFor(me)->enabled);
  // An address no account owns writes nothing and says so, which is what keeps the webhook from
  // being an account-existence oracle.
  CHECK_FALSE(h.nudges->stopMailing(Email{"stranger@example.com"}));
}

TEST(nudge_the_owner_turning_it_on_lifts_a_suppression) {
  // The one deliberate act that clears the provider's verdict: the owner, signed in, PATCHing
  // enabled:true — which is them saying the address works now. Being wrong costs one more bounce.
  // The PATCH answers the fresh settings, so the lift must show in the reply, not only in the row.
  Harness h(NudgeArming(true, "u1"));
  UserId me = h.signIn("s-live");
  NudgeSettings on;
  on.enabled = true;
  on.nextDueAtMs = h.clock->now + 3'600'000;
  on.slotDay = ld("2026-07-28");
  h.nudges->upsertSettings(me, on);
  h.nudges->emails[me.str()] = Email{"sam@example.com"};
  CHECK(h.nudges->stopMailing(Email{"sam@example.com"}));

  Json::Value patch(Json::objectValue);
  patch["enabled"] = true;
  drogon::HttpResponsePtr response =
      patchSettings(h, request(drogon::Patch, "/v1/journal/nudge", dump(patch), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string(R"({"adaptive":true,"armed":true,"channel":"email","enabled":true,)"
                       R"("nextDueAt":1700003600000,"suppressed":false})"));
  std::optional<NudgeSettings> stored = h.nudges->settingsFor(me);
  REQUIRE(stored.has_value());
  CHECK_FALSE(stored->suppressed);
  CHECK(stored->enabled);
  CHECK(stored->nextDueAtMs == std::optional<std::uint64_t>(1'700'003'600'000ULL));
}

TEST(nudge_a_patch_that_does_not_say_enabled_leaves_a_suppression_alone) {
  // A row already reading "on" is not the owner speaking: moving the channel over it changes a
  // preference and says nothing about the mailbox, so the provider's fact stands.
  Harness h(NudgeArming(true, "u1"));
  UserId me = h.signIn("s-live");
  NudgeSettings on;
  on.enabled = true;
  on.nextDueAtMs = h.clock->now + 3'600'000;
  on.slotDay = ld("2026-07-28");
  h.nudges->upsertSettings(me, on);
  h.nudges->emails[me.str()] = Email{"sam@example.com"};
  CHECK(h.nudges->stopMailing(Email{"sam@example.com"}));

  Json::Value patch(Json::objectValue);
  patch["channel"] = "inapp";
  drogon::HttpResponsePtr response =
      patchSettings(h, request(drogon::Patch, "/v1/journal/nudge", dump(patch), "s-live"));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_EQ(dump(*response->getJsonObject()),
           std::string(R"({"adaptive":true,"armed":true,"channel":"inapp","enabled":true,)"
                       R"("nextDueAt":1700003600000,"suppressed":true})"));
  CHECK(h.nudges->settingsFor(me)->suppressed);
  CHECK(h.nudges->settingsFor(me)->enabled);
}
