#include "products/journal/adapters/http/EchoApi.h"

#include "platform/application/Entitlements.h"
#include "platform/adapters/json/JsonText.h"
#include "test/application/AuthFakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <memory>
#include <string>
#include <utility>

using namespace wm;
using namespace wm::fake;

namespace {

// The same harness NudgeApiTest runs on, plus the echo half: the fake repository, a REAL EchoSweep
// over the fakes, and the api under test. The first user the auth fake mints is "u1".
struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  std::shared_ptr<FakeTokens> tokens = std::make_shared<FakeTokens>();
  std::shared_ptr<FakeClock> clock = std::make_shared<FakeClock>();
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, *tokens, *clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, *tokens, *clock, oauth, footprint, "https://windmill.works");
  std::shared_ptr<FakeEchoRepository> echoes = std::make_shared<FakeEchoRepository>();
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeSubscriptionRepository subscriptions;
  Entitlements entitlements{subscriptions};
  std::shared_ptr<EchoSweep> sweep;
  std::shared_ptr<EchoApi> api;

  explicit Harness(std::string adminToken = "")
      : sweep(std::make_shared<EchoSweep>(*echoes, embedder, curator, *clock, SelectionRules{},
                                          SweepBudget{})),
        api(std::make_shared<EchoApi>(echoes, sweep, auth,
                                      std::shared_ptr<Entitlements>(&entitlements, [](Entitlements*) {}),
                                      std::move(adminToken))) {}

  UserId signIn(const std::string& sessionSecret, const std::string& address = "sam@example.com") {
    User user = authRepo.createUser(Email{address}, "sam");
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

Json::Value listOf(Harness& h, const std::string& session) {
  drogon::HttpResponsePtr captured;
  h.api->listEchoes(request(drogon::Get, "/v1/journal/echoes", "", session),
                    [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return parse(std::string(captured->getBody()));
}

drogon::HttpResponsePtr dismissPair(Harness& h, const std::string& session,
                                    const std::string& triggerDay, const std::string& matchDay) {
  drogon::HttpResponsePtr captured;
  h.api->dismiss(
      request(drogon::Post, "/v1/journal/echoes/" + triggerDay + "/" + matchDay + "/dismiss", "",
              session),
      [&](const drogon::HttpResponsePtr& r) { captured = r; }, triggerDay, matchDay);
  return captured;
}

drogon::HttpResponsePtr dismissPage(Harness& h, const std::string& session,
                                    const std::string& triggerDay) {
  drogon::HttpResponsePtr captured;
  h.api->dismissPage(
      request(drogon::Post, "/v1/journal/echoes/" + triggerDay + "/dismiss", "", session),
      [&](const drogon::HttpResponsePtr& r) { captured = r; }, triggerDay);
  return captured;
}

drogon::HttpResponsePtr dismissOffer(Harness& h, const std::string& session,
                                     const std::string& triggerDay) {
  drogon::HttpResponsePtr captured;
  h.api->dismissOffer(
      request(drogon::Post, "/v1/journal/echoes/" + triggerDay + "/offer/dismiss", "", session),
      [&](const drogon::HttpResponsePtr& r) { captured = r; }, triggerDay);
  return captured;
}

drogon::HttpResponsePtr adminSweep(Harness& h, const drogon::HttpRequestPtr& req) {
  drogon::HttpResponsePtr captured;
  h.api->adminSweep(req, [&](const drogon::HttpResponsePtr& r) { captured = r; });
  return captured;
}

// One echo already on a page, planted the way a finished pass would have left it: a trigger passage
// on tonight's page, a match passage two years back, and both pages present with the bodies those
// passages were cut from — which is what the anchoring hint is counted against.
const std::string kTonight = "i like c++ these days, more than i expected to.";
const std::string kJanuary = "i want to learn c++ properly one of these years.";

void plantEcho(Harness& h, const UserId& user) {
  h.echoes->plantPage(user, ld("2026-05-01"), kTonight);
  h.echoes->plantSpan(user, ld("2026-05-01"), 21, kTonight, {});
  h.echoes->plantPage(user, ld("2024-01-01"), kJanuary);
  h.echoes->plantSpan(user, ld("2024-01-01"), 11, kJanuary, {});

  CuratedEchoes curated;
  curated.curatorVersion = "fake-curator-v1";
  curated.rows.push_back(EchoRow{21, ld("2024-01-01"), 11, 0.8f, 0.9f, true});
  h.echoes->replaceEchoes(user, ld("2026-05-01"), curated);
}

// A page carrying three matches — the panel "Not useful" retires in one tap. Every passage names
// its own day, because dismissal is keyed on CONTENT: two pages carrying literally the same
// sentences are one pair, and a fixture that ignored that would be testing nothing.
std::string panelTrigger(const std::string& day) {
  return "tonight i wrote about the same old thing, on " + day + " of all nights.";
}
std::string panelMatch(const std::string& matchYear, int at) {
  return "the same old thing, in " + matchYear + ", the " + std::to_string(at) + " time i wrote it.";
}
std::string panelMatchDay(const std::string& matchYear, int at) {
  return matchYear + "-0" + std::to_string(at) + "-01";
}

// Span ids are namespaced by `base` so two accounts planting the same shape never share one.
void plantPanel(Harness& h, const UserId& user, const std::string& day,
                const std::string& matchYear, std::int64_t base) {
  h.echoes->plantPage(user, ld(day), panelTrigger(day));
  h.echoes->plantSpan(user, ld(day), base, panelTrigger(day), {});

  CuratedEchoes curated;
  curated.curatorVersion = "fake-curator-v1";
  for (int at = 1; at <= 3; ++at) {
    const LocalDate matchDay = ld(panelMatchDay(matchYear, at));
    h.echoes->plantPage(user, matchDay, panelMatch(matchYear, at));
    h.echoes->plantSpan(user, matchDay, base + at, panelMatch(matchYear, at), {});
    curated.rows.push_back(EchoRow{base, matchDay, base + at, 0.8f, 0.9f, true});
  }
  h.echoes->replaceEchoes(user, ld(day), curated);
}

// How many matches the reader is shown on one page — 0 when the page is not in the list at all,
// which is what a fully retired panel looks like.
unsigned matchesOn(const Json::Value& body, const std::string& day) {
  for (const Json::Value& page : body["pages"])
    if (page["day"].asString() == day) return page["matches"].size();
  return 0;
}

bool offerRetiredOn(const Json::Value& body, const std::string& day) {
  for (const Json::Value& page : body["pages"])
    if (page["day"].asString() == day) return page["offerRetired"].asBool();
  return false;
}

}

TEST(echoes_needs_a_signed_in_reader) {
  Harness h;
  drogon::HttpResponsePtr captured;
  h.api->listEchoes(request(drogon::Get, "/v1/journal/echoes"),
                    [&](const drogon::HttpResponsePtr& r) { captured = r; });
  CHECK_EQ(static_cast<int>(captured->statusCode()), 401);
}

TEST(echoes_are_grouped_by_the_page_that_carries_them) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantEcho(h, user);

  const Json::Value body = listOf(h, "s-live");
  CHECK_EQ(body["pages"].size(), 1u);
  CHECK_EQ(body["pages"][0]["day"].asString(), std::string("2026-05-01"));
  CHECK(!body["pages"][0]["offerRetired"].asBool());   // nobody has said "not now" here
  CHECK_EQ(body["pages"][0]["matches"].size(), 1u);
  CHECK_EQ(body["pages"][0]["matches"][0]["day"].asString(), std::string("2024-01-01"));
}

// The honest cut. A subscriber is handed the passage; everyone else is handed its real opening
// words and the number withheld — which tells the truth about what exists, rather than the older
// behaviour of hiding that anything was found at all.
TEST(an_unentitled_reader_is_told_what_exists_and_shown_only_its_opening_words) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantEcho(h, user);

  const Json::Value page = listOf(h, "s-live")["pages"][0];

  CHECK(!page["entitled"].asBool());
  CHECK_EQ(page["matches"].size(), 1u);   // the echo is NOT hidden
  CHECK_EQ(page["matches"][0]["text"].asString(),
           std::string("i want to learn c++ properly one of"));
  CHECK_EQ(page["matches"][0]["withheldWords"].asInt(), 2);
  // No hint on a prefix: the number counts occurrences of the WHOLE passage, and a reader holding
  // eight words of it would be searching for something else entirely.
  CHECK(!page["matches"][0].isMember("occurrenceHint"));
}

TEST(a_subscriber_is_handed_the_whole_passage) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantEcho(h, user);

  const Json::Value page = listOf(h, "s-live")["pages"][0];

  CHECK(page["entitled"].asBool());
  CHECK_EQ(page["matches"][0]["text"].asString(), kJanuary);
  CHECK_EQ(page["matches"][0]["withheldWords"].asInt(), 0);
  CHECK_EQ(page["matches"][0]["occurrenceHint"].asInt(), 0);
}

// The anchoring hint, and the case it exists for. A page saying the same sentence twice gives a
// text search no way to pick the right one, and first-occurrence is all a client without this can
// do. It is an occurrence index rather than an offset on purpose: C++ counts bytes, the browser
// slices UTF-16 code units, and an occurrence index has no encoding in it to disagree about.
TEST(a_passage_repeated_on_its_page_says_which_occurrence_it_is) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);

  const std::string line = "i don't know what to do about any of it.";
  const std::string body = line + "\nthe day was long and grey and then it was over.\n" + line;
  const int second = static_cast<int>(body.rfind(line));

  h.echoes->plantPage(user, ld("2026-05-01"), kTonight);
  h.echoes->plantSpan(user, ld("2026-05-01"), 21, kTonight, {});
  h.echoes->plantPage(user, ld("2024-01-01"), body);
  h.echoes->plantSpan(user, ld("2024-01-01"), 11, line, {}, 0);
  h.echoes->plantSpan(user, ld("2024-01-01"), 12, line, {}, second);

  CuratedEchoes curated;
  curated.curatorVersion = "fake-curator-v1";
  curated.rows.push_back(EchoRow{21, ld("2024-01-01"), 12, 0.8f, 0.9f, true});
  h.echoes->replaceEchoes(user, ld("2026-05-01"), curated);

  const Json::Value match = listOf(h, "s-live")["pages"][0]["matches"][0];
  CHECK_EQ(match["text"].asString(), line);
  CHECK_EQ(match["occurrenceHint"].asInt(), 1);   // the SECOND one, not the first
}

// A hint the server cannot stand behind is not sent. The passage was derived from a body that has
// since moved under it, so there is no occurrence to name and the client goes back to searching.
TEST(a_body_edited_under_a_passage_carries_no_hint_at_all) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantEcho(h, user);
  h.echoes->plantPage(user, ld("2024-01-01"), "a line inserted above it.\n" + kJanuary);

  const Json::Value match = listOf(h, "s-live")["pages"][0]["matches"][0];
  CHECK_EQ(match["text"].asString(), kJanuary);
  CHECK(!match.isMember("occurrenceHint"));
}

// The ~20-page corpus floor. The surface owes the reader no mark and no offer below it, and the
// browser cannot count pages it has not synced — so the count is served or the floor is fiction.
TEST(the_read_says_how_many_pages_the_reader_has_written) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantEcho(h, user);
  h.echoes->plantPage(user, ld("2026-04-30"), "   \n  ");   // opened, never written on

  CHECK_EQ(listOf(h, "s-live")["pagesWritten"].asInt(), 2);
}

TEST(a_reader_with_no_echoes_at_all_is_still_told_the_size_of_their_corpus) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.echoes->plantPage(user, ld("2026-04-29"), "wrote a little.");
  h.echoes->plantPage(user, ld("2026-04-30"), "wrote a little more.");

  const Json::Value body = listOf(h, "s-live");
  CHECK_EQ(body["pages"].size(), 0u);
  CHECK_EQ(body["pagesWritten"].asInt(), 2);
}

// "Not useful" is one tap on a panel, so it is one request. Nine matches used to cost nine
// round trips, each able to fail on its own and leave the page half faded.
TEST(dismissing_a_page_retires_every_pairing_it_carries) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);
  CHECK_EQ(matchesOn(listOf(h, "s-live"), "2026-05-01"), 3u);

  CHECK_EQ(static_cast<int>(dismissPage(h, "s-live", "2026-05-01")->statusCode()), 204);
  CHECK_EQ(matchesOn(listOf(h, "s-live"), "2026-05-01"), 0u);
  CHECK_EQ(listOf(h, "s-live")["pages"].size(), 0u);
}

TEST(dismissing_a_page_twice_says_the_same_thing_the_first_time_did) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(dismissPage(h, "s-live", "2026-05-01")->statusCode()), 204);
  CHECK_EQ(static_cast<int>(dismissPage(h, "s-live", "2026-05-01")->statusCode()), 204);
  CHECK_EQ(h.echoes->dismissals[user.str()].size(), 3u);   // three pairs, not six
  CHECK_EQ(matchesOn(listOf(h, "s-live"), "2026-05-01"), 0u);
}

TEST(dismissing_a_page_that_never_carried_an_echo_is_still_a_204) {
  Harness h;
  h.signIn("s-live");
  CHECK_EQ(static_cast<int>(dismissPage(h, "s-live", "2026-05-01")->statusCode()), 204);
}

TEST(dismissing_one_page_leaves_the_reader_s_other_pages_alone) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);
  plantPanel(h, user, "2026-06-01", "2023", 200);

  CHECK_EQ(static_cast<int>(dismissPage(h, "s-live", "2026-05-01")->statusCode()), 204);
  const Json::Value body = listOf(h, "s-live");
  CHECK_EQ(matchesOn(body, "2026-05-01"), 0u);
  CHECK_EQ(matchesOn(body, "2026-06-01"), 3u);
}

// Owner-scoped, and a forged day proves it: the same page number in another account is untouched,
// because the only user id the handler ever sees is the one on the session.
TEST(dismissing_a_page_cannot_reach_another_account) {
  Harness h;
  const UserId mine = h.signIn("s-mine", "sam@example.com");
  const UserId theirs = h.signIn("s-theirs", "ada@example.com");
  h.subscriptions.subscribe(mine);
  h.subscriptions.subscribe(theirs);
  plantPanel(h, mine, "2026-05-01", "2024", 100);
  plantPanel(h, theirs, "2026-05-01", "2024", 200);

  CHECK_EQ(static_cast<int>(dismissPage(h, "s-mine", "2026-05-01")->statusCode()), 204);
  CHECK_EQ(matchesOn(listOf(h, "s-mine"), "2026-05-01"), 0u);
  CHECK_EQ(matchesOn(listOf(h, "s-theirs"), "2026-05-01"), 3u);
}

TEST(dismissing_a_page_needs_a_signed_in_reader) {
  Harness h;
  CHECK_EQ(static_cast<int>(dismissPage(h, "", "2026-05-01")->statusCode()), 401);
}

TEST(dismissing_a_page_that_is_not_a_date_is_refused) {
  Harness h;
  h.signIn("s-live");
  CHECK_EQ(static_cast<int>(dismissPage(h, "s-live", "not-a-day")->statusCode()), 400);
}

// The pair-level door stays: a reader retiring one match out of nine still has one, and it retires
// exactly that one.
TEST(dismissing_one_pairing_leaves_the_rest_of_the_panel_standing) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(dismissPair(h, "s-live", "2026-05-01", "2024-02-01")->statusCode()), 204);
  const Json::Value body = listOf(h, "s-live");
  CHECK_EQ(matchesOn(body, "2026-05-01"), 2u);
  CHECK_EQ(body["pages"][0]["matches"][0]["day"].asString(), std::string("2024-01-01"));
  CHECK_EQ(body["pages"][0]["matches"][1]["day"].asString(), std::string("2024-03-01"));
}

// Dismissal is keyed on what the two passages SAY, never on where they sit. Insert a line above a
// passage and its span moves; a position-keyed dismissal would hand the reader back the very echo
// they retired, which is the worst failure this feature has.
TEST(a_dismissed_page_stays_dismissed_when_its_passages_move) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);
  CHECK_EQ(static_cast<int>(dismissPage(h, "s-live", "2026-05-01")->statusCode()), 204);

  // The night re-derives the page: same text, brand new identities, and a line inserted above the
  // trigger so every offset on it has moved.
  const std::string opening = "a new opening line.\n";
  h.echoes->plantPage(user, ld("2026-05-01"), opening + panelTrigger("2026-05-01"));
  h.echoes->plantSpan(user, ld("2026-05-01"), 900, panelTrigger("2026-05-01"), {},
                      static_cast<int>(opening.size()));
  CuratedEchoes curated;
  curated.curatorVersion = "fake-curator-v1";
  for (int at = 1; at <= 3; ++at) {
    const LocalDate matchDay = ld(panelMatchDay("2024", at));
    h.echoes->plantSpan(user, matchDay, 900 + at, panelMatch("2024", at), {});
    curated.rows.push_back(EchoRow{900, matchDay, 900 + at, 0.8f, 0.9f, true});
  }
  h.echoes->replaceEchoes(user, ld("2026-05-01"), curated);

  CHECK_EQ(matchesOn(listOf(h, "s-live"), "2026-05-01"), 0u);
}

// "Not now" is a different answer from "Not useful", and it costs the reader nothing: the offer
// stops, every echo on the page stays. A page whose offer was declined and whose echoes were then
// silently dropped would be the feature punishing someone for not buying it.
TEST(declining_the_offer_retires_the_asking_and_not_one_echo) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);
  CHECK(!offerRetiredOn(listOf(h, "s-live"), "2026-05-01"));

  CHECK_EQ(static_cast<int>(dismissOffer(h, "s-live", "2026-05-01")->statusCode()), 204);

  const Json::Value body = listOf(h, "s-live");
  CHECK(offerRetiredOn(body, "2026-05-01"));
  CHECK_EQ(matchesOn(body, "2026-05-01"), 3u);   // the echoes are untouched
  CHECK(!body["pages"][0]["entitled"].asBool());   // and so is the honest cut
}

// Served, never remembered by the device. A decline only one device knows about is a decline the
// next device ignores, and being asked again on your phone is the nagging this refuses to do.
TEST(the_read_carries_the_offer_state_back_so_no_device_has_to_remember_it) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);
  plantPanel(h, user, "2026-06-01", "2023", 200);
  dismissOffer(h, "s-live", "2026-06-01");

  const Json::Value body = listOf(h, "s-live");
  CHECK(!offerRetiredOn(body, "2026-05-01"));
  CHECK(offerRetiredOn(body, "2026-06-01"));
}

TEST(declining_the_offer_twice_says_the_same_thing_the_first_time_did) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(dismissOffer(h, "s-live", "2026-05-01")->statusCode()), 204);
  CHECK_EQ(static_cast<int>(dismissOffer(h, "s-live", "2026-05-01")->statusCode()), 204);
  CHECK_EQ(h.echoes->offersRetired.size(), std::size_t{1});
  CHECK(offerRetiredOn(listOf(h, "s-live"), "2026-05-01"));
}

TEST(declining_one_page_s_offer_leaves_another_day_and_another_account_asking) {
  Harness h;
  const UserId mine = h.signIn("s-mine", "sam@example.com");
  const UserId theirs = h.signIn("s-theirs", "ada@example.com");
  plantPanel(h, mine, "2026-05-01", "2024", 100);
  plantPanel(h, mine, "2026-06-01", "2023", 200);
  plantPanel(h, theirs, "2026-05-01", "2024", 300);

  CHECK_EQ(static_cast<int>(dismissOffer(h, "s-mine", "2026-05-01")->statusCode()), 204);

  const Json::Value mineBody = listOf(h, "s-mine");
  CHECK(offerRetiredOn(mineBody, "2026-05-01"));
  CHECK(!offerRetiredOn(mineBody, "2026-06-01"));
  CHECK(!offerRetiredOn(listOf(h, "s-theirs"), "2026-05-01"));   // a forged day reaches nobody else
}

// The two answers are independent in both directions: retiring the echoes says nothing about the
// offer, and declining the offer says nothing about the echoes.
TEST(retiring_a_page_s_echoes_is_not_an_answer_to_the_offer) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(dismissPage(h, "s-live", "2026-05-01")->statusCode()), 204);
  CHECK_EQ(h.echoes->offersRetired.size(), std::size_t{0});
}

TEST(declining_an_offer_needs_a_signed_in_reader) {
  Harness h;
  CHECK_EQ(static_cast<int>(dismissOffer(h, "", "2026-05-01")->statusCode()), 401);
}

TEST(declining_an_offer_on_something_that_is_not_a_date_is_refused) {
  Harness h;
  h.signIn("s-live");
  CHECK_EQ(static_cast<int>(dismissOffer(h, "s-live", "not-a-day")->statusCode()), 400);
}

TEST(an_admin_sweep_without_a_token_is_refused) {
  Harness h;
  CHECK_EQ(static_cast<int>(
               adminSweep(h, request(drogon::Post, "/v1/admin/journal/echo/sweep"))->statusCode()),
           403);
}
