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

// The first user the auth fake mints is "u1".
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

// Dismissal is keyed on CONTENT, so every passage names its own day.
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

unsigned matchesOn(const Json::Value& body, const std::string& day) {
  for (const Json::Value& page : body["pages"])
    if (page["day"].asString() == day) return page["matches"].size();
  return 0;
}

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
  CHECK(!body["pages"][0]["offerRetired"].asBool());
  REQUIRE_EQ(body["pages"][0]["matches"].size(), 1u);
  CHECK_EQ(body["pages"][0]["matches"][0]["day"].asString(), std::string("2024-01-01"));
}

TEST(an_unentitled_reader_is_told_what_exists_and_shown_only_its_opening_words) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantEcho(h, user);

  const Json::Value page = listOf(h, "s-live")["pages"][0];

  CHECK(!page["entitled"].asBool());
  REQUIRE_EQ(page["matches"].size(), 1u);
  CHECK_EQ(page["matches"][0]["text"].asString(),
           std::string("i want to learn c++ properly one of"));
  CHECK_EQ(page["matches"][0]["withheldWords"].asInt(), 2);
  // No hint on a prefix: the number counts occurrences of the WHOLE passage.
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

TEST(a_dismissed_page_stays_dismissed_when_its_passages_move) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);
  CHECK_EQ(static_cast<int>(dismissPage(h, "s-live", "2026-05-01")->statusCode()), 204);

  // The night re-derives the page: same text, new identities, and a line inserted above the trigger so every offset moved.
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

TEST(declining_the_offer_retires_the_asking_and_not_one_echo) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);
  CHECK(!offerRetiredOn(listOf(h, "s-live"), "2026-05-01"));

  CHECK_EQ(static_cast<int>(dismissOffer(h, "s-live", "2026-05-01")->statusCode()), 204);

  const Json::Value body = listOf(h, "s-live");
  CHECK(offerRetiredOn(body, "2026-05-01"));
  CHECK_EQ(matchesOn(body, "2026-05-01"), 3u);
  CHECK(!body["pages"][0]["entitled"].asBool());
}

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
  CHECK(!offerRetiredOn(listOf(h, "s-theirs"), "2026-05-01"));
}

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

TEST(dismissing_one_pairing_retires_it_and_records_that_it_was_not_useful) {
  Harness h;
  const UserId user = h.signIn("s-live");
  h.subscriptions.subscribe(user);
  plantPanel(h, user, "2026-05-01", "2024", 100);

  CHECK_EQ(static_cast<int>(dismissPair(h, "s-live", "2026-05-01", "2024-02-01")->statusCode()), 204);

  CHECK(h.echoes->isDismissed(user, panelTrigger("2026-05-01"), panelMatch("2024", 2)));
  CHECK(matchOn(listOf(h, "s-live"), "2026-05-01", "2024-02-01").isNull());

  const std::vector<FakeEchoRepository::StoredSignal>& signals = h.echoes->signals[user.str()];
  REQUIRE_EQ(signals.size(), std::size_t{1});
  CHECK_EQ(signals[0].matchSpanId, std::int64_t{102});
  CHECK(signals[0].kind == EchoSignal::notUseful);
  CHECK_EQ(signals[0].curatorVersion, std::string("fake-curator-v1"));
}

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
  CHECK_EQ(matchesOn(listOf(h, "s-live"), "2026-05-01"), 0u);
}

TEST(dismissing_a_page_twice_records_three_signals_and_not_six) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  dismissPage(h, "s-live", "2026-05-01");
  dismissPage(h, "s-live", "2026-05-01");

  CHECK_EQ(h.echoes->signals[user.str()].size(), std::size_t{3});
}

TEST(declining_the_offer_records_no_judgement_at_all) {
  Harness h;
  const UserId user = h.signIn("s-live");
  plantPanel(h, user, "2026-05-01", "2024", 100);

  dismissOffer(h, "s-live", "2026-05-01");

  CHECK_EQ(h.echoes->signals[user.str()].size(), std::size_t{0});
}

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
  Harness h("the-secret");
  drogon::HttpRequestPtr req = request(drogon::Post, "/v1/admin/journal/echo/sweep");
  req->addHeader("x-admin-token", "the-secret");

  const SweepAnswer answer = sweepOf(h, req);

  CHECK_EQ(static_cast<int>(answer.response->statusCode()), 200);
  CHECK(answer.answeredOn != std::this_thread::get_id());
}

namespace {

// A hand-built drogon request does not parse its own query string, so `query` is set field by field.
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

// The fake embedder counts letters, so a sentence and its near-copy sit close together.
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
  CHECK_EQ(candidates[0]["fate"].asString(), std::string{"restatement"});
  CHECK_EQ(candidates[0]["day"].asString(), std::string{"2026-01-05"});
  CHECK(candidates[0]["cosine"].asDouble() >= 0.97);
  CHECK_EQ(explained["proposed"].size(), Json::ArrayIndex{0});
  CHECK_EQ(explained["rules"]["restatement"].asDouble(), 0.97);

  CHECK_EQ(h.echoes->spansOf(user, ld(kExplainToday)).size(), std::size_t{0});
  CHECK_EQ(h.echoes->echoesFor(user, ld(kExplainToday), ld(kExplainToday)).size(), std::size_t{0});
  CHECK_EQ(h.curator.calls, 0);
}

TEST(a_raised_restatement_threshold_lets_the_same_night_through) {
  Harness h("s3cret");
  const UserId user = h.signIn("sess");
  plantForExplain(h, user);

  const Json::Value explained = parse(std::string(
      explainOf(h, kExplainToday, "?token=s3cret&restatement=1.01&curate=1", "sess")->getBody()));

  CHECK_EQ(explained["rules"]["restatement"].asDouble(), 1.01);
  REQUIRE_EQ(explained["proposed"].size(), Json::ArrayIndex{1});
  CHECK_EQ(explained["proposed"][0]["matchSpanId"].asInt64(), std::int64_t{11});
  CHECK_EQ(explained["triggers"][0]["candidates"][0]["fate"].asString(), std::string{"selected"});
  CHECK_EQ(h.curator.calls, 1);
  REQUIRE_EQ(explained["verdicts"].size(), Json::ArrayIndex{1});
  CHECK_EQ(explained["verdicts"][0]["related"].asBool(), true);
}
