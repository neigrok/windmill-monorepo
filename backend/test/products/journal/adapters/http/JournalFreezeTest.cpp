#include "products/journal/adapters/http/EchoApi.h"
#include "products/journal/adapters/http/JournalApi.h"
#include "products/journal/adapters/http/NudgeApi.h"
#include "products/journal/adapters/http/VoiceApi.h"
#include "products/journal/application/EchoDerivations.h"
#include "products/journal/application/JournalSwitches.h"
#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

using namespace wm;
using namespace wm::fake;

namespace {

struct Freeze {
  std::optional<std::string> previous;
  Freeze() {
    if (const char* value = std::getenv("JOURNAL_WRITE_FREEZE")) previous = value;
    setenv("JOURNAL_WRITE_FREEZE", "1", 1);
  }
  ~Freeze() {
    if (previous) setenv("JOURNAL_WRITE_FREEZE", previous->c_str(), 1);
    else unsetenv("JOURNAL_WRITE_FREEZE");
  }
};

}

TEST(journal_freeze_refuses_every_mutation_before_auth_parse_or_storage) {
  Freeze frozen;
  JournalApi pages(nullptr, nullptr);
  EchoApi echoes(nullptr, nullptr, nullptr, nullptr, nullptr, "");
  NudgeApi nudges(nullptr, nullptr, nullptr, nullptr, nullptr, "");
  VoiceApi voice(nullptr, nullptr, nullptr);
  const auto req = drogon::HttpRequest::newHttpRequest();
  req->setBody("not json");
  int responses = 0;
  const auto answer = [&](const drogon::HttpResponsePtr& response) {
    ++responses;
    CHECK_EQ(response->getStatusCode(), drogon::k503ServiceUnavailable);
    Json::Value expected(Json::objectValue);
    expected["code"] = "journal-frozen";
    expected["error"] = "journal writes are temporarily frozen";
    REQUIRE(response->getJsonObject());
    CHECK_EQ(*response->getJsonObject(), expected);
  };
  pages.putPage(req, answer, "bad date");
  echoes.dismiss(req, answer, "bad", "bad");
  echoes.dismissPage(req, answer, "bad");
  echoes.dismissOffer(req, answer, "bad");
  echoes.markUseful(req, answer, "bad", "bad");
  echoes.opened(req, answer, "bad", "bad");
  echoes.adminSweep(req, answer);
  nudges.patchSettings(req, answer);
  nudges.pause(req, answer);
  nudges.unsubscribe(req, answer);
  nudges.adminSweep(req, answer);
  voice.transcribe(req, answer);
  CHECK_EQ(responses, 12);
}

TEST(journal_freeze_keeps_reads_and_defers_queued_echo_and_nudge_work) {
  FakeJournalRepository pages;
  PageService service(pages);
  const Page page(uid(), ld("2026-10-01"), "Words.", Score(0), std::nullopt, Source::spoken, hlc(1), 17);
  pages.save(page);
  FakeEchoRepository echoes;
  FakeSegmenter segmenter;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements(subscriptions, usage);
  EchoSweep sweep(echoes, segmenter, embedder, curator, clock, entitlements, SelectionRules{}, SweepBudget{});
  EchoExplainer explainer(echoes, segmenter, embedder, curator, service);
  EchoDerivations live(sweep, clock, LiveDerivationRules{});
  echoes.addUser(uid());
  echoes.addDuePage(uid(), page.day, page.body);
  live.pageSaved(uid(), page.day, page.body.size());
  FakeNudgeRepository nudges;
  FakeNudgeMail mail;
  FakeTokens tokens;
  NudgeSweep nudge(nudges, mail, tokens, clock, MailArming(true, "u1"), "https://windmill.works");
  nudges.armDue(uid(), Email("journal@example.com"), page.day, 1);
  {
    Freeze frozen;
    CHECK_EQ(service.page(uid(), page.day), std::optional<Page>(page));
    CHECK_EQ(service.all(uid()), std::vector<Page>{page});
    bool refused = false;
    try { service.write(Page(uid(), page.day)); }
    catch (const journal::JournalUnavailable& error) { refused = error.code == "journal-frozen"; }
    CHECK(refused);
    CHECK_EQ(live.drain(clock.now + 10'000).derived, 0);
    live.pageSaved(uid(), ld("2026-10-02"), 6);
    CHECK_EQ(sweep.derivePage(uid(), page.day).usersScanned, 0);
    CHECK_EQ(sweep.run(0).usersScanned, 0);
    for (const bool recut : {false, true}) {
      const auto explained = explainer.explain(uid(), ExplainRequest{.day = page.day, .rules = SelectionRules{}, .curate = true, .recut = recut});
      CHECK(explained.pageFound);
      CHECK_EQ(explained.body, page.body);
      CHECK_EQ(segmenter.calls, 0);
      CHECK_EQ(embedder.calls, 0);
      CHECK_EQ(curator.calls, 0);
    }
    CHECK(!nudge.run(clock.now, false).ran);
    CHECK(nudges.claims.empty());
    CHECK(echoes.derived.empty());
    CHECK_EQ(curator.calls, 0);
    CHECK_EQ(pages.load(uid(), page.day), std::optional<Page>(page));
  }
  CHECK_EQ(live.drain(clock.now + 10'000).derived, 1);
  CHECK_EQ(echoes.derived, std::vector<std::string>{FakeEchoRepository::pageKey(uid(), page.day)});
}
