#include "products/journal/adapters/http/EchoApi.h"

#include "platform/application/Entitlements.h"
#include "platform/adapters/json/JsonText.h"
#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
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
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage};
  FakeJournalRepository pages;
  PageService pageService{pages};
  std::shared_ptr<EchoSweep> sweep;
  std::shared_ptr<EchoExplainer> explainer;
  std::shared_ptr<EchoApi> api;

  explicit Harness(std::string adminToken = "")
      : sweep(std::make_shared<EchoSweep>(*echoes, segmenter, embedder, curator, *clock,
                                          entitlements, SelectionRules{}, SweepBudget{})),
        explainer(std::make_shared<EchoExplainer>(*echoes, segmenter, embedder, curator,
                                                  pageService)),
        api(std::make_shared<EchoApi>(echoes, sweep, explainer, auth,
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

drogon::HttpResponsePtr markUseful(Harness& h, const std::string& session,
                                   const std::string& triggerDay, const std::string& matchDay) {
  drogon::HttpResponsePtr captured;
  h.api->markUseful(
      request(drogon::Post, "/v1/journal/echoes/" + triggerDay + "/" + matchDay + "/useful", "",
              session),
      [&](const drogon::HttpResponsePtr& r) { captured = r; }, triggerDay, matchDay);
  return captured;
}

drogon::HttpResponsePtr opened(Harness& h, const std::string& session,
                               const std::string& triggerDay, const std::string& matchDay) {
  drogon::HttpResponsePtr captured;
  h.api->opened(
      request(drogon::Post, "/v1/journal/echoes/" + triggerDay + "/" + matchDay + "/opened", "",
              session),
      [&](const drogon::HttpResponsePtr& r) { captured = r; }, triggerDay, matchDay);
  return captured;
}

// A pass that RUNS answers from the sweep's own loop, never the thread that called it — a repair
// pass is minutes of embedder and curator calls, and the caller is one of the handful of IO threads
// serving every other route in the product. So the test waits for it, as a client would. A refusal
// still answers inline, and the wait costs it nothing.
struct SweepAnswer {
  drogon::HttpResponsePtr response;
  std::thread::id answeredOn;
};

SweepAnswer sweepOf(Harness& h, const drogon::HttpRequestPtr& req) {
  std::promise<SweepAnswer> settled;
  std::future<SweepAnswer> answer = settled.get_future();
  h.api->adminSweep(req, [&](const drogon::HttpResponsePtr& r) {
    settled.set_value(SweepAnswer{r, std::this_thread::get_id()});
  });
  answer.wait();
  return answer.get();
}

drogon::HttpResponsePtr adminSweep(Harness& h, const drogon::HttpRequestPtr& req) {
  return sweepOf(h, req).response;
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

// One match as the reader is handed it, or a null value when the pairing is no longer shown.
Json::Value matchOn(const Json::Value& body, const std::string& day, const std::string& matchDay) {
  for (const Json::Value& page : body["pages"]) {
    if (page["day"].asString() != day) continue;
    for (const Json::Value& match : page["matches"])
      if (match["day"].asString() == matchDay) return match;
  }
  return Json::Value();
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
  REQUIRE_EQ(body["pages"].size(), 1u);
  CHECK_EQ(body["pages"][0]["day"].asString(), std::string("2026-05-01"));
  CHECK(!body["pages"][0]["offerRetired"].asBool());   // nobody has said "not now" here
  REQUIRE_EQ(body["pages"][0]["matches"].size(), 1u);
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
  REQUIRE_EQ(page["matches"].size(), 1u);   // the echo is NOT hidden
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

// ── The quality signals ─────────────────────────────────────────────────────────────────────────
// Dismissal alone cannot tell "wrong match" from "right match, bad night". These are what let the
// curator be measured rather than believed, and every one of them is written with the retrieval
// score and the curator's own version beside it.

TEST(marking_a_match_useful_records_it_with_the_score_and_the_curator_that_produced_it) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(markUseful(h, "s-live", "2026-05-01", "2024-02-01")->statusCode()), 204);

  const std::vector<FakeEchoRepository::StoredSignal>& signals = h.echoes->signals[user.str()];
  REQUIRE_EQ(signals.size(), std::size_t{1});
  CHECK_EQ(signals[0].triggerDay.iso(), std::string("2026-05-01"));
  CHECK_EQ(signals[0].triggerSpanId, std::int64_t{100});
  CHECK_EQ(signals[0].matchDay.iso(), std::string("2024-02-01"));
  CHECK_EQ(signals[0].matchSpanId, std::int64_t{102});
  CHECK(signals[0].kind == EchoSignal::useful);
  CHECK_EQ(signals[0].cosine, 0.8f);
  CHECK_EQ(signals[0].relation, 0.9f);
  CHECK_EQ(signals[0].curatorVersion, std::string("fake-curator-v1"));
}

// The answer has to survive the trip to another device, which is the whole reason it is server-side
// rather than a flag in the browser. Marked comes back marked; everything else comes back false.
TEST(the_read_carries_the_useful_answer_back_and_says_false_for_every_match_that_has_none) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);
  CHECK(!matchOn(listOf(h, "s-live"), "2026-05-01", "2024-02-01")["useful"].asBool());

  markUseful(h, "s-live", "2026-05-01", "2024-02-01");

  const Json::Value body = listOf(h, "s-live");
  CHECK(matchOn(body, "2026-05-01", "2024-02-01")["useful"].asBool());
  CHECK(!matchOn(body, "2026-05-01", "2024-01-01")["useful"].asBool());
  CHECK(!matchOn(body, "2026-05-01", "2024-03-01")["useful"].asBool());
}

// An unentitled reader is shown eight words of the passage and no more — but "I already said this
// one was useful" is a fact about them, not about what they have paid for.
TEST(the_useful_answer_is_carried_back_across_the_honest_cut_too) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);
  markUseful(h, "s-live", "2026-05-01", "2024-02-01");

  const Json::Value match = matchOn(listOf(h, "s-live"), "2026-05-01", "2024-02-01");
  CHECK(match["useful"].asBool());
  CHECK(match["withheldWords"].asInt() > 0);
}

TEST(marking_a_match_useful_twice_says_the_same_thing_the_first_time_did) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(markUseful(h, "s-live", "2026-05-01", "2024-02-01")->statusCode()), 204);
  CHECK_EQ(static_cast<int>(markUseful(h, "s-live", "2026-05-01", "2024-02-01")->statusCode()), 204);
  CHECK_EQ(h.echoes->signals[user.str()].size(), std::size_t{1});   // one row, not two
}

TEST(marking_a_pairing_that_was_never_on_the_page_records_nothing_and_is_still_a_204) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(markUseful(h, "s-live", "2026-05-01", "2023-09-09")->statusCode()), 204);
  CHECK_EQ(h.echoes->signals[user.str()].size(), std::size_t{0});
}

TEST(marking_a_match_useful_needs_a_signed_in_reader) {
  Harness h;
  CHECK_EQ(static_cast<int>(markUseful(h, "", "2026-05-01", "2024-02-01")->statusCode()), 401);
}

TEST(marking_something_that_is_not_a_date_useful_is_refused) {
  Harness h;
  h.signIn("s-live");
  CHECK_EQ(static_cast<int>(markUseful(h, "s-live", "2026-05-01", "not-a-day")->statusCode()), 400);
}

// Marking one useful is not an answer about the others, and it is not an answer about the page.
TEST(one_useful_mark_reaches_neither_another_pairing_nor_another_account) {
  Harness h;
  const UserId mine = h.signIn("s-mine", "sam@example.com");
  const UserId theirs = h.signIn("s-theirs", "ada@example.com");
  plantPanel(h, mine, "2026-05-01", "2024", 100);
  plantPanel(h, theirs, "2026-05-01", "2024", 200);

  markUseful(h, "s-mine", "2026-05-01", "2024-02-01");

  CHECK_EQ(h.echoes->signals[mine.str()].size(), std::size_t{1});
  CHECK_EQ(h.echoes->signals[theirs.str()].size(), std::size_t{0});
  CHECK(!matchOn(listOf(h, "s-theirs"), "2026-05-01", "2024-02-01")["useful"].asBool());
}

// The dismissal says two separate things and both are now written down: the pair is retired, AND
// it was wrong. The retirement is the guarantee that must not regress — a dismissed pair never
// comes back — and the judgement is the negative half of the dataset.
TEST(dismissing_one_pairing_retires_it_and_records_that_it_was_not_useful) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(dismissPair(h, "s-live", "2026-05-01", "2024-02-01")->statusCode()), 204);

  CHECK(h.echoes->isDismissed(user, panelTrigger("2026-05-01"), panelMatch("2024", 2)));
  CHECK(matchOn(listOf(h, "s-live"), "2026-05-01", "2024-02-01").isNull());   // and it stays gone

  const std::vector<FakeEchoRepository::StoredSignal>& signals = h.echoes->signals[user.str()];
  REQUIRE_EQ(signals.size(), std::size_t{1});
  CHECK_EQ(signals[0].matchSpanId, std::int64_t{102});
  CHECK(signals[0].kind == EchoSignal::notUseful);
  CHECK_EQ(signals[0].curatorVersion, std::string("fake-curator-v1"));
}

// "Not useful" on the panel is the gesture where a reader actually says it, so the judgement is
// recorded for every pairing the tap retired — a dataset that heard only the pair-level door would
// be missing most of its negative labels.
TEST(dismissing_a_page_records_that_every_pairing_on_it_was_not_useful) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(dismissPage(h, "s-live", "2026-05-01")->statusCode()), 204);

  CHECK_EQ(h.echoes->signals[user.str()].size(), std::size_t{3});
  CHECK(h.echoes->hasSignal(user, 100, 101, EchoSignal::notUseful));
  CHECK(h.echoes->hasSignal(user, 100, 102, EchoSignal::notUseful));
  CHECK(h.echoes->hasSignal(user, 100, 103, EchoSignal::notUseful));
  CHECK_EQ(matchesOn(listOf(h, "s-live"), "2026-05-01"), 0u);   // and the page stays retired
}

TEST(dismissing_a_page_twice_records_three_signals_and_not_six) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  dismissPage(h, "s-live", "2026-05-01");
  dismissPage(h, "s-live", "2026-05-01");

  CHECK_EQ(h.echoes->signals[user.str()].size(), std::size_t{3});
}

// Declining the OFFER is not a judgement about anything. It retires the asking and nothing else,
// so it must leave the dataset alone.
TEST(declining_the_offer_records_no_judgement_at_all) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  dismissOffer(h, "s-live", "2026-05-01");

  CHECK_EQ(h.echoes->signals[user.str()].size(), std::size_t{0});
}

// The walk back to the older page. It used to be a LOG_INFO line and nothing else — a signal
// collected and thrown away — and it is a weaker label than "useful", so it is its own kind rather
// than folded in with one.
TEST(walking_back_to_the_older_page_is_recorded_as_its_own_kind) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(opened(h, "s-live", "2026-05-01", "2024-03-01")->statusCode()), 204);

  const std::vector<FakeEchoRepository::StoredSignal>& signals = h.echoes->signals[user.str()];
  REQUIRE_EQ(signals.size(), std::size_t{1});
  CHECK_EQ(signals[0].matchSpanId, std::int64_t{103});
  CHECK(signals[0].kind == EchoSignal::opened);
  CHECK_EQ(signals[0].cosine, 0.8f);
  // opening is not endorsing: the read still says nobody called this one useful
  CHECK(!matchOn(listOf(h, "s-live"), "2026-05-01", "2024-03-01")["useful"].asBool());
}

TEST(opening_the_same_pairing_twice_records_one_row) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(opened(h, "s-live", "2026-05-01", "2024-03-01")->statusCode()), 204);
  CHECK_EQ(static_cast<int>(opened(h, "s-live", "2026-05-01", "2024-03-01")->statusCode()), 204);
  CHECK_EQ(h.echoes->signals[user.str()].size(), std::size_t{1});
}

// The three answers are three kinds, and one pairing can carry all of them: opened on Monday,
// useful on Tuesday, retired in March. Collapsing them would lose exactly the distinction the
// table exists to record.
TEST(the_three_answers_about_one_pairing_are_three_rows) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  opened(h, "s-live", "2026-05-01", "2024-01-01");
  markUseful(h, "s-live", "2026-05-01", "2024-01-01");
  dismissPair(h, "s-live", "2026-05-01", "2024-01-01");

  CHECK_EQ(h.echoes->signals[user.str()].size(), std::size_t{3});
  CHECK(h.echoes->hasSignal(user, 100, 101, EchoSignal::opened));
  CHECK(h.echoes->hasSignal(user, 100, 101, EchoSignal::useful));
  CHECK(h.echoes->hasSignal(user, 100, 101, EchoSignal::notUseful));
}

TEST(walking_back_needs_a_signed_in_reader) {
  Harness h;
  CHECK_EQ(static_cast<int>(opened(h, "", "2026-05-01", "2024-01-01")->statusCode()), 401);
}

TEST(walking_back_from_something_that_is_not_a_date_is_refused) {
  Harness h;
  h.signIn("s-live");
  CHECK_EQ(static_cast<int>(opened(h, "s-live", "not-a-day", "2024-01-01")->statusCode()), 400);
}

TEST(an_admin_sweep_without_a_token_is_refused) {
  Harness h;
  CHECK_EQ(static_cast<int>(
               adminSweep(h, request(drogon::Post, "/v1/admin/journal/echo/sweep"))->statusCode()),
           403);
}

TEST(an_admin_sweep_runs_off_the_calling_thread) {
  // A repair pass is minutes of embedder and curator calls. It used to run inline on the drogon IO
  // thread that took the request, holding one of the twenty pooled connections throughout.
  Harness h("the-secret");
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/admin/journal/echo/sweep");
  req->addHeader("x-admin-token", "the-secret");

  const SweepAnswer answer = sweepOf(h, req);

  CHECK_EQ(static_cast<int>(answer.response->statusCode()), 200);
  CHECK(answer.answeredOn != std::this_thread::get_id());
}

// The tuning door. It answers about the CALLER's own page, writes nothing, and its whole value is
// the reason it gives — so the tests below are about the reason and about who may ask for one.

namespace {

// `query` is written the way it would be typed — "?token=s3cret&restatement=1.01" — and set on the
// request field by field, because a hand-built drogon request does not parse its own query string.
drogon::HttpResponsePtr explainOf(Harness& h, const std::string& day, const std::string& query,
                                  const std::string& session) {
  const drogon::HttpRequestPtr req =
      request(drogon::Get, "/v1/admin/journal/echo/explain/" + day, "", session);
  for (std::size_t at = query.empty() ? std::string::npos : 1; at < query.size();) {
    const std::size_t end = std::min(query.find('&', at), query.size());
    const std::size_t equals = query.find('=', at);
    if (equals < end) req->setParameter(query.substr(at, equals - at),
                                        query.substr(equals + 1, end - equals - 1));
    at = end + 1;
  }

  std::promise<drogon::HttpResponsePtr> settled;
  std::future<drogon::HttpResponsePtr> answer = settled.get_future();
  h.api->explainPage(req, [&](const drogon::HttpResponsePtr& r) { settled.set_value(r); }, day);
  answer.wait();
  return answer.get();
}

// Tonight, and a page from January the writer has half-forgotten. The fake embedder counts letters,
// so a sentence and its near-copy sit close together and two different sentences do not.
const std::string kExplainToday = "2026-08-23";
const std::string kExplainTonight = "i want to learn the rust compiler properly";
const std::string kExplainJanuary = "i want to learn the rust compiler properly this year";

void plantForExplain(Harness& h, const UserId& user) {
  h.pageService.write(Page{user, ld(kExplainToday), kExplainTonight, Mood::none, Energy::none,
                           Source::typed, Hlc{h.clock->now, 0, "device"}, h.clock->now});
  h.echoes->plantPage(user, ld("2026-01-05"), kExplainJanuary);
  h.echoes->plantSpan(user, ld("2026-01-05"), 11, kExplainJanuary,
                      h.embedder.embed({kExplainJanuary}).front());
}

}

TEST(the_tuning_door_needs_the_admin_token_and_an_owner_behind_it) {
  Harness h("s3cret");
  const UserId user = h.signIn("sess");
  plantForExplain(h, user);

  CHECK_EQ(explainOf(h, kExplainToday, "", "sess")->getStatusCode(), drogon::k403Forbidden);
  CHECK_EQ(explainOf(h, kExplainToday, "?token=wrong", "sess")->getStatusCode(),
           drogon::k403Forbidden);
  // The admin secret opens the door. It never names whose journal is behind it.
  CHECK_EQ(explainOf(h, kExplainToday, "?token=s3cret", "")->getStatusCode(),
           drogon::k401Unauthorized);
  CHECK_EQ(explainOf(h, kExplainToday, "?token=s3cret", "sess")->getStatusCode(), drogon::k200OK);
}

TEST(the_tuning_door_names_the_rule_that_ate_the_reach_back_and_writes_nothing) {
  Harness h("s3cret");
  const UserId user = h.signIn("sess");
  plantForExplain(h, user);

  const Json::Value explained =
      parse(std::string(explainOf(h, kExplainToday, "?token=s3cret", "sess")->getBody()));

  CHECK_EQ(explained["page"]["found"].asBool(), true);
  CHECK_EQ(explained["wiring"]["embedVersion"].asString(), std::string{"fake-embedder-v1"});
  CHECK_EQ(explained["corpus"]["history"].asInt(), 1);
  CHECK_EQ(explained["passages"].size(), Json::ArrayIndex{1});
  REQUIRE_EQ(explained["triggers"].size(), Json::ArrayIndex{1});
  const Json::Value& candidates = explained["triggers"][0]["candidates"];
  REQUIRE_EQ(candidates.size(), Json::ArrayIndex{1});
  // The whole point: the page reaches back to nothing, and this says WHY it reaches back to
  // nothing — near-identical text is read as the same sentence again, not as a memory.
  CHECK_EQ(candidates[0]["fate"].asString(), std::string{"restatement"});
  CHECK_EQ(candidates[0]["day"].asString(), std::string{"2026-01-05"});
  CHECK(candidates[0]["cosine"].asDouble() >= 0.97);
  CHECK_EQ(explained["proposed"].size(), Json::ArrayIndex{0});
  // The rules it ran with travel back, so a swept threshold can be told from a typo.
  CHECK_EQ(explained["rules"]["restatement"].asDouble(), 0.97);

  // And nothing was persisted by asking: no span row for tonight, no echo row, no curator call.
  CHECK_EQ(h.echoes->spansOf(user, ld(kExplainToday)).size(), std::size_t{0});
  CHECK_EQ(h.echoes->echoesFor(user, ld(kExplainToday), ld(kExplainToday)).size(), std::size_t{0});
  CHECK_EQ(h.curator.calls, 0);
}

TEST(a_raised_restatement_threshold_lets_the_same_night_through) {
  Harness h("s3cret");
  const UserId user = h.signIn("sess");
  plantForExplain(h, user);

  // The knob an operator came here to move, moved for one call and no deploy.
  const Json::Value explained = parse(std::string(
      explainOf(h, kExplainToday, "?token=s3cret&restatement=1.01&curate=1", "sess")->getBody()));

  CHECK_EQ(explained["rules"]["restatement"].asDouble(), 1.01);
  REQUIRE_EQ(explained["proposed"].size(), Json::ArrayIndex{1});
  CHECK_EQ(explained["proposed"][0]["matchSpanId"].asInt64(), std::int64_t{11});
  CHECK_EQ(explained["triggers"][0]["candidates"][0]["fate"].asString(), std::string{"selected"});
  // `curate=1` is the one part of this that bills, so it happens only when it is asked for.
  CHECK_EQ(h.curator.calls, 1);
  REQUIRE_EQ(explained["verdicts"].size(), Json::ArrayIndex{1});
  CHECK_EQ(explained["verdicts"][0]["related"].asBool(), true);
}
