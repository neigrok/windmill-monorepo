#include "products/roadmap/adapters/http/RemindersApi.h"

#include "products/roadmap/adapters/json/TreeJson.h"
#include "test/application/AuthFakes.h"
#include "test/application/ReminderFakes.h"
#include "test/testing.h"

#include <cstdint>
#include <future>
#include <memory>
#include <string>
#include <thread>
#include <utility>

using namespace wm;
using namespace wm::fake;

namespace {

constexpr std::uint64_t kDay = 24ull * 60 * 60 * 1000;

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  std::shared_ptr<FakeTokens> tokens = std::make_shared<FakeTokens>();
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, *tokens, *clock};
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, *tokens, *clock, oauth, "https://windmill.works");
  std::shared_ptr<FakeReminders> reminders = std::make_shared<FakeReminders>();
  std::shared_ptr<ReminderSweep> sweep;
  std::shared_ptr<RemindersApi> api;

  explicit Harness(ReminderArming arming = ReminderArming(), std::string adminToken = "")
      : sweep(std::make_shared<ReminderSweep>(*reminders, email, *tokens, *clock, std::move(arming),
                                              "https://windmill.works")),
        api(std::make_shared<RemindersApi>(sweep, reminders, auth, tokens, clock,
                                           std::move(adminToken))) {}

  // The first user the fake mints is "u1", which is the id every allowlist below names.
  UserId signIn(const std::string& sessionSecret) {
    User user = authRepo.createUser(Email{"sam@example.com"}, "sam");
    authRepo.insertSession(tokens->digestOf(sessionSecret), user.id, clock->now + 1'000'000, "", "",
                           clock->now);
    return user.id;
  }

  // One person the sweep would otherwise write to, so a rehearsal has something to rehearse.
  void planOneDueUser() {
    DueUser row;
    row.user = UserId{"u1"};
    row.email = Email{"sam@example.com"};
    row.slotDate = "2026-07-28";
    row.slotInstantMs = clock->now - 60'000;
    reminders->due = {row};
    reminders->lastActive["u1"] = clock->now - 14 * kDay;
    reminders->born["u1"] = clock->now - 90 * kDay;
    TreeReadiness tree;
    tree.id = TreeId{"t_a"};
    tree.title = "Learn to sail";
    tree.lastActivityAtMs = clock->now - 20 * kDay;
    tree.total = 12;
    tree.done = 5;
    tree.ready = {ReadyStep{NodeId{"rigging"}, "Rig the boat", NodeColor::olive}};
    reminders->readiness["u1"] = {tree};
  }
};

drogon::HttpRequestPtr request(drogon::HttpMethod method, const std::string& path,
                               const std::string& body) {
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(method);
  req->setPath(path);
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(body);
  return req;
}

drogon::HttpRequestPtr signedIn(drogon::HttpMethod method, const std::string& path,
                                const std::string& body) {
  drogon::HttpRequestPtr req = request(method, path, body);
  req->addHeader("authorization", "Bearer s-live");
  return req;
}

drogon::HttpResponsePtr get(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->getSettings(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

drogon::HttpResponsePtr patch(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->patchSettings(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

drogon::HttpResponsePtr pause(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->pause(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

// The one-click secret rides the query, not the body — an empty token stands for a URL with no `t`.
drogon::HttpResponsePtr unsubscribe(Harness& h, const std::string& token) {
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/reminders/unsubscribe", "");
  if (!token.empty()) req->setParameter("t", token);
  drogon::HttpResponsePtr captured;
  h.api->unsubscribe(req, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

// The admin sweep answers from the sweep's OWN loop, never the thread that called it, so the test
// waits for it exactly as a client would. `answeredOn` is the proof of that: a run that came back
// on this thread would have blocked a drogon IO thread for the length of the whole batch.
struct SweepAnswer {
  drogon::HttpResponsePtr response;
  std::thread::id answeredOn;
};

SweepAnswer sweep(Harness& h, const drogon::HttpRequestPtr& req) {
  std::promise<SweepAnswer> settled;
  std::future<SweepAnswer> answer = settled.get_future();
  h.api->sweep(req, [&](const drogon::HttpResponsePtr& response) {
    settled.set_value(SweepAnswer{response, std::this_thread::get_id()});
  });
  answer.wait();
  return answer.get();
}

Json::Value bodyOf(const drogon::HttpResponsePtr& response) { return *response->getJsonObject(); }

}

TEST(reminders_an_account_with_no_row_reads_back_the_honest_defaults) {
  Harness h;
  h.signIn("s-live");

  drogon::HttpResponsePtr response = get(h, signedIn(drogon::Get, "/v1/reminders", ""));

  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  const Json::Value body = bodyOf(response);
  CHECK_FALSE(body["armed"].asBool());
  CHECK_FALSE(body["enabled"].asBool());
  CHECK_EQ(body["timezone"].asString(), std::string(""));
  CHECK_EQ(body["slotDow"].asInt(), kDefaultSlotDow);
  CHECK_EQ(body["slotMinute"].asInt(), kDefaultSlotMinute);
  CHECK_FALSE(body["suppressed"].asBool());
}

TEST(reminders_a_signed_out_caller_is_asked_to_sign_in) {
  Harness h;

  CHECK_EQ(get(h, request(drogon::Get, "/v1/reminders", ""))->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(patch(h, request(drogon::Patch, "/v1/reminders", R"({"enabled":false})"))->getStatusCode(),
           drogon::k401Unauthorized);
}

TEST(reminders_armed_answers_whether_the_engine_can_reach_THIS_caller) {
  // The rollout state .env.example prescribes: the feature enabled, an allowlist of one. Answering
  // this question with the feature's flag alone would advertise the switch to every signed-in
  // stranger, who would turn it on, be told when we send, and receive nothing for a month.
  Harness reachable(ReminderArming(true, "u1"));
  reachable.signIn("s-live");
  CHECK(bodyOf(get(reachable, signedIn(drogon::Get, "/v1/reminders", "")))["armed"].asBool());

  Harness enabledButNotForYou(ReminderArming(true, "somebody-else"));
  enabledButNotForYou.signIn("s-live");
  CHECK_FALSE(
      bodyOf(get(enabledButNotForYou, signedIn(drogon::Get, "/v1/reminders", "")))["armed"].asBool());

  Harness dark(ReminderArming(false, "u1"));
  dark.signIn("s-live");
  CHECK_FALSE(bodyOf(get(dark, signedIn(drogon::Get, "/v1/reminders", "")))["armed"].asBool());
}

TEST(reminders_a_patch_edits_only_the_fields_it_carries) {
  Harness h(ReminderArming(true, "u1"));
  h.signIn("s-live");

  CHECK_EQ(patch(h, signedIn(drogon::Patch, "/v1/reminders", R"({"timezone":"Europe/Berlin"})"))
               ->getStatusCode(),
           drogon::k204NoContent);
  Json::Value body = bodyOf(get(h, signedIn(drogon::Get, "/v1/reminders", "")));
  CHECK_FALSE(body["enabled"].asBool());
  CHECK_EQ(body["timezone"].asString(), std::string("Europe/Berlin"));

  // Turning it on carries no timezone, and must not erase the one already stored.
  CHECK_EQ(patch(h, signedIn(drogon::Patch, "/v1/reminders", R"({"enabled":true})"))->getStatusCode(),
           drogon::k204NoContent);
  body = bodyOf(get(h, signedIn(drogon::Get, "/v1/reminders", "")));
  CHECK(body["enabled"].asBool());
  CHECK_EQ(body["timezone"].asString(), std::string("Europe/Berlin"));
}

TEST(reminders_enabling_without_a_timezone_is_refused) {
  // No zone means no hour to send at, and defaulting to UTC would mail US users at 4am. Refusing
  // beats accepting the row into permanent silence.
  Harness h(ReminderArming(true, "u1"));
  h.signIn("s-live");

  drogon::HttpResponsePtr response =
      patch(h, signedIn(drogon::Patch, "/v1/reminders", R"({"enabled":true})"));

  CHECK_EQ(response->getStatusCode(), drogon::k400BadRequest);
  CHECK_EQ(h.reminders->settings.size(), std::size_t{0});
}

TEST(reminders_enabling_is_refused_for_anyone_the_engine_cannot_reach) {
  // No row may claim "on" while the sweep cannot deliver to its owner: that row would decide an
  // honest week every Tuesday and withhold every single one of them.
  Harness h(ReminderArming(true, "somebody-else"));
  h.signIn("s-live");

  drogon::HttpResponsePtr response = patch(
      h, signedIn(drogon::Patch, "/v1/reminders", R"({"enabled":true,"timezone":"Europe/Berlin"})"));

  CHECK_EQ(response->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(h.reminders->settings.size(), std::size_t{0});
}

TEST(reminders_a_field_of_the_wrong_type_is_a_400_and_never_a_500) {
  // jsoncpp's asBool/asString THROW on a type they cannot convert, and an exception out of a
  // handler is a 500, a server_errors row and a Sentry event — mintable by any signed-in caller.
  Harness h(ReminderArming(true, "u1"));
  h.signIn("s-live");

  CHECK_EQ(patch(h, signedIn(drogon::Patch, "/v1/reminders", R"({"enabled":"on"})"))->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ(patch(h, signedIn(drogon::Patch, "/v1/reminders", R"({"timezone":42})"))->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ(patch(h, signedIn(drogon::Patch, "/v1/reminders", R"({"timezone":["a"]})"))->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ(patch(h, signedIn(drogon::Patch, "/v1/reminders", "not json at all"))->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ(h.reminders->settings.size(), std::size_t{0});
}

TEST(reminders_a_timezone_the_database_does_not_know_is_refused) {
  Harness h(ReminderArming(true, "u1"));
  h.signIn("s-live");
  h.reminders->unknownTimezones.insert("Mars/Olympus_Mons");

  CHECK_EQ(patch(h, signedIn(drogon::Patch, "/v1/reminders", R"({"timezone":"Mars/Olympus_Mons"})"))
               ->getStatusCode(),
           drogon::k400BadRequest);
  CHECK_EQ(patch(h, signedIn(drogon::Patch, "/v1/reminders", R"({"timezone":")" +
                                                                 std::string(80, 'x') + R"("})"))
               ->getStatusCode(),
           drogon::k400BadRequest);
}

TEST(reminders_the_pause_door_answers_204_to_everything_it_is_given) {
  // It takes no credential and can never say no: a token that matches nothing gets the same answer
  // as one that matches, so this door can never be asked whose reminders exist.
  Harness h;
  h.reminders->pauseDigests["u1"] = "d1";
  h.reminders->settings["u1"].enabled = true;

  CHECK_EQ(pause(h, request(drogon::Post, "/v1/reminders/pause", R"({"token":"nope"})"))
               ->getStatusCode(),
           drogon::k204NoContent);
  CHECK(h.reminders->settings["u1"].enabled);  // a stranger's guess changes nothing

  CHECK_EQ(pause(h, request(drogon::Post, "/v1/reminders/pause", R"({"token":"s1"})"))
               ->getStatusCode(),
           drogon::k204NoContent);
  CHECK_FALSE(h.reminders->settings["u1"].enabled);
  // And the credential is spent: a forwarded reminder must not stay a live pause link forever.
  CHECK_EQ(h.reminders->pauseDigests.count("u1"), std::size_t{0});
}

TEST(reminders_a_pause_body_of_the_wrong_shape_is_still_a_204_and_never_a_500) {
  // This handler is UNCREDENTIALED. A throw here would be an anonymous 500 generator: one
  // server_errors row and one Sentry event per request, at whatever rate the sender likes.
  Harness h;

  CHECK_EQ(pause(h, request(drogon::Post, "/v1/reminders/pause", R"({"token":[]})"))->getStatusCode(),
           drogon::k204NoContent);
  CHECK_EQ(pause(h, request(drogon::Post, "/v1/reminders/pause", R"({"token":7})"))->getStatusCode(),
           drogon::k204NoContent);
  CHECK_EQ(pause(h, request(drogon::Post, "/v1/reminders/pause", "{}"))->getStatusCode(),
           drogon::k204NoContent);
  CHECK_EQ(pause(h, request(drogon::Post, "/v1/reminders/pause", "garbage"))->getStatusCode(),
           drogon::k204NoContent);
}

TEST(reminders_the_one_click_unsubscribe_spends_the_same_secret_pause_does) {
  // RFC 8058: a mail client POSTs the List-Unsubscribe URL for the reader, carrying the query
  // secret from their own mail. Like pause it answers the same to a matching and a non-matching
  // secret, and the credential is single-use.
  Harness h;
  h.reminders->pauseDigests["u1"] = "d1";
  h.reminders->settings["u1"].enabled = true;

  CHECK_EQ(unsubscribe(h, "nope")->getStatusCode(), drogon::k200OK);
  CHECK(h.reminders->settings["u1"].enabled);  // a stranger's guess changes nothing

  CHECK_EQ(unsubscribe(h, "s1")->getStatusCode(), drogon::k200OK);
  CHECK_FALSE(h.reminders->settings["u1"].enabled);
  CHECK_EQ(h.reminders->pauseDigests.count("u1"), std::size_t{0});  // spent
}

TEST(reminders_unsubscribe_with_no_token_is_a_200_and_a_noop) {
  // A prefetcher or scanner that reaches this URL without the `t` — or the door's own empty case —
  // must change nothing and still answer a clean 2xx, never throw out of an uncredentialed handler.
  Harness h;
  h.reminders->pauseDigests["u1"] = "d1";
  h.reminders->settings["u1"].enabled = true;

  CHECK_EQ(unsubscribe(h, "")->getStatusCode(), drogon::k200OK);
  CHECK(h.reminders->settings["u1"].enabled);
  CHECK_EQ(h.reminders->pauseDigests.count("u1"), std::size_t{1});
}

TEST(reminders_the_admin_sweep_is_a_404_rather_than_a_403) {
  // A 403 would confirm the route exists. An unconfigured token and a wrong one answer identically.
  Harness unconfigured;
  CHECK_EQ(sweep(unconfigured, request(drogon::Post, "/v1/admin/reminders/sweep", "{}"))
               .response->getStatusCode(),
           drogon::k404NotFound);

  Harness h(ReminderArming(), "the-secret");
  CHECK_EQ(
      sweep(h, request(drogon::Post, "/v1/admin/reminders/sweep", "{}")).response->getStatusCode(),
      drogon::k404NotFound);

  drogon::HttpRequestPtr wrong = request(drogon::Post, "/v1/admin/reminders/sweep", "{}");
  wrong->addHeader("authorization", "Bearer the-secre");
  CHECK_EQ(sweep(h, wrong).response->getStatusCode(), drogon::k404NotFound);
}

TEST(reminders_an_admin_sweep_runs_off_the_calling_thread) {
  // A full batch is up to 200 users' worth of database round trips and provider calls. Running it
  // on the thread that took the request would pin a quarter of the server's IO for that long.
  Harness h(ReminderArming(), "the-secret");
  h.planOneDueUser();
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/admin/reminders/sweep", "{}");
  req->addHeader("authorization", "Bearer the-secret");

  const SweepAnswer answer = sweep(h, req);

  CHECK_EQ(answer.response->getStatusCode(), drogon::k200OK);
  CHECK(answer.answeredOn != std::this_thread::get_id());
  const Json::Value body = bodyOf(answer.response);
  CHECK(body["ran"].asBool());
  CHECK_EQ(body["due"].asInt(), 1);
  CHECK_EQ(body["claimed"].asInt(), 1);
  CHECK_EQ(body["held"].asInt(), 1);  // dark engine: decided, claimed, withheld
  CHECK_EQ(body["sent"].asInt(), 0);
  CHECK_EQ(body["wouldSend"].asInt(), 0);
}

TEST(reminders_a_time_travelling_sweep_is_refused_while_the_engine_is_armed) {
  Harness h(ReminderArming(true, "u1"), "the-secret");
  h.planOneDueUser();
  drogon::HttpRequestPtr req =
      request(drogon::Post, "/v1/admin/reminders/sweep", R"({"asOfMs":1900000000000})");
  req->addHeader("authorization", "Bearer the-secret");

  const SweepAnswer answer = sweep(h, req);

  CHECK_EQ(answer.response->getStatusCode(), drogon::k409Conflict);
  CHECK_EQ(h.reminders->claims.size(), std::size_t{0});
}

TEST(reminders_a_time_travelling_sweep_is_always_a_rehearsal) {
  // The pointer advance computes next week from SQL now(), not from asOfMs, so a real run against
  // a future clock would claim the whole fleet's week and push every pointer against real time.
  // One mistyped rehearsal would cost everybody their next reminder.
  Harness h(ReminderArming(), "the-secret");
  h.planOneDueUser();
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/admin/reminders/sweep",
                                       R"({"asOfMs":1700000000000,"dryRun":false})");
  req->addHeader("authorization", "Bearer the-secret");

  const SweepAnswer answer = sweep(h, req);

  CHECK_EQ(answer.response->getStatusCode(), drogon::k200OK);
  const Json::Value body = bodyOf(answer.response);
  CHECK_EQ(body["due"].asInt(), 1);
  CHECK_EQ(body["claimed"].asInt(), 0);
  CHECK_EQ(body["wouldSend"].asInt(), 1);
  CHECK_EQ(body["held"].asInt(), 0);
  CHECK_EQ(h.reminders->claims.size(), std::size_t{0});
  CHECK_EQ(h.reminders->closes.size(), std::size_t{0});
}

TEST(reminders_an_admin_sweep_of_the_wrong_shape_is_a_400) {
  Harness h(ReminderArming(), "the-secret");
  h.planOneDueUser();

  drogon::HttpRequestPtr badClock =
      request(drogon::Post, "/v1/admin/reminders/sweep", R"({"asOfMs":"soon"})");
  badClock->addHeader("authorization", "Bearer the-secret");
  CHECK_EQ(sweep(h, badClock).response->getStatusCode(), drogon::k400BadRequest);

  // A number is not enough: asUInt64 throws on a negative or a fraction exactly as it does on a
  // string, and every one of those throws would be the same anonymous 500.
  drogon::HttpRequestPtr negativeClock =
      request(drogon::Post, "/v1/admin/reminders/sweep", R"({"asOfMs":-1})");
  negativeClock->addHeader("authorization", "Bearer the-secret");
  CHECK_EQ(sweep(h, negativeClock).response->getStatusCode(), drogon::k400BadRequest);

  drogon::HttpRequestPtr fractionalClock =
      request(drogon::Post, "/v1/admin/reminders/sweep", R"({"asOfMs":1.5})");
  fractionalClock->addHeader("authorization", "Bearer the-secret");
  CHECK_EQ(sweep(h, fractionalClock).response->getStatusCode(), drogon::k400BadRequest);

  drogon::HttpRequestPtr badFlag =
      request(drogon::Post, "/v1/admin/reminders/sweep", R"({"dryRun":"yes"})");
  badFlag->addHeader("authorization", "Bearer the-secret");
  CHECK_EQ(sweep(h, badFlag).response->getStatusCode(), drogon::k400BadRequest);

  CHECK_EQ(h.reminders->claims.size(), std::size_t{0});
}
