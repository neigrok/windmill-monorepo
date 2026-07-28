#include "products/journal/application/EchoSweep.h"

#include "platform/application/Entitlements.h"
#include "test/application/AuthFakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <string>

using namespace wm;
using namespace wm::fake;

namespace {

constexpr std::uint64_t kNow = 1'700'000'000'000;
constexpr std::uint64_t kDay = 24ull * 60 * 60 * 1000;
const std::string kOldDay = "2026-06-01";
const std::string kRecentDay = "2026-07-01";                 // thirty days on, well past the reach
const std::string kBody = "the same reflection returns tonight";

// One user whose recent page already carries a vector that resonates with an older one — the whole
// resonance in place, so a test can vary only the entitlement or the embedder around it.
void armResonantUser(FakeEchoRepository& echoes, FakeEmbedder& embedder) {
  echoes.addUser(uid("u1"), Email{"writer@example.com"});
  echoes.addCorpusEntry(uid("u1"), ld(kOldDay), embedder.embed(kBody), kBody);
  echoes.addCorpusEntry(uid("u1"), ld(kRecentDay), embedder.embed(kBody), kBody);
  echoes.addTrigger(uid("u1"), ld(kRecentDay));
}

}

TEST(a_subscriber_whose_page_resonates_with_an_older_one_saves_exactly_one_echo) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeSubscriptionRepository subs;
  FakeClock clock;
  armResonantUser(echoes, embedder);
  subs.subscribe(uid("u1"));

  Entitlements entitlements(subs);
  EchoSweep sweep(echoes, embedder, entitlements, clock, EchoRules{});
  const EchoSweepReport report = sweep.run(kNow, kNow - kDay);

  CHECK_EQ(report.usersScanned, 1);
  CHECK_EQ(report.vectorsComputed, 0);          // both pages were already vectored
  CHECK_EQ(report.echoesFound, 1);
  CHECK_EQ(report.skippedNotSubscribed, 0);

  CHECK_EQ(echoes.savedEchoes.size(), std::size_t{1});
  CHECK_EQ(echoes.savedEchoes[0].user, uid("u1"));
  CHECK(echoes.savedEchoes[0].triggerDay == ld(kRecentDay));
  CHECK(echoes.savedEchoes[0].match.matchDay == ld(kOldDay));
  CHECK(echoes.savedEchoes[0].match.score > 0.99f);
}

TEST(a_non_subscriber_with_the_same_setup_gets_no_echo_and_is_counted_skipped) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeSubscriptionRepository subs;                // no subscribe(): unentitled
  FakeClock clock;
  armResonantUser(echoes, embedder);

  Entitlements entitlements(subs);
  EchoSweep sweep(echoes, embedder, entitlements, clock, EchoRules{});
  const EchoSweepReport report = sweep.run(kNow, kNow - kDay);

  CHECK_EQ(report.usersScanned, 1);
  CHECK_EQ(report.skippedNotSubscribed, 1);
  CHECK_EQ(report.echoesFound, 0);
  CHECK_EQ(report.vectorsComputed, 0);
  CHECK_EQ(echoes.savedEchoes.size(), std::size_t{0});
  CHECK_EQ(echoes.savedVectors.size(), std::size_t{0});   // an unentitled user is never even read
}

TEST(an_unconfigured_embedder_makes_the_whole_pass_a_no_op) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  embedder.isConfigured = false;                  // no upstream wired
  FakeSubscriptionRepository subs;
  FakeClock clock;
  armResonantUser(echoes, embedder);
  subs.subscribe(uid("u1"));

  Entitlements entitlements(subs);
  EchoSweep sweep(echoes, embedder, entitlements, clock, EchoRules{});
  const EchoSweepReport report = sweep.run(kNow, kNow - kDay);

  CHECK_EQ(report.usersScanned, 0);               // not a single user is scanned
  CHECK_EQ(report.vectorsComputed, 0);
  CHECK_EQ(report.echoesFound, 0);
  CHECK_EQ(report.skippedNotSubscribed, 0);
  CHECK_EQ(echoes.savedEchoes.size(), std::size_t{0});
  CHECK_EQ(echoes.savedVectors.size(), std::size_t{0});
}

TEST(a_page_missing_its_vector_is_embedded_before_it_is_matched) {
  FakeEchoRepository echoes;
  FakeEmbedder embedder;
  FakeSubscriptionRepository subs;
  FakeClock clock;

  echoes.addUser(uid("u1"), Email{"writer@example.com"});
  subs.subscribe(uid("u1"));
  echoes.addCorpusEntry(uid("u1"), ld(kOldDay), embedder.embed(kBody), kBody);  // old page, already vectored
  echoes.addPageNeedingVector(uid("u1"), ld(kRecentDay), kBody, 4242);           // recent page, no vector yet
  echoes.addTrigger(uid("u1"), ld(kRecentDay));

  Entitlements entitlements(subs);
  EchoSweep sweep(echoes, embedder, entitlements, clock, EchoRules{});
  const EchoSweepReport report = sweep.run(kNow, kNow - kDay);

  CHECK_EQ(report.vectorsComputed, 1);
  CHECK_EQ(report.echoesFound, 1);

  // The vector was computed from the page's body and stamped with the page's HLC ms.
  CHECK_EQ(echoes.savedVectors.size(), std::size_t{1});
  CHECK_EQ(echoes.savedVectors[0].user, uid("u1"));
  CHECK(echoes.savedVectors[0].day == ld(kRecentDay));
  CHECK_EQ(echoes.savedVectors[0].stampMs, std::uint64_t{4242});
  CHECK_EQ(echoes.savedVectors[0].vector, embedder.embed(kBody));

  // And that freshly-embedded page then resonated with the older one.
  CHECK_EQ(echoes.savedEchoes.size(), std::size_t{1});
  CHECK(echoes.savedEchoes[0].triggerDay == ld(kRecentDay));
  CHECK(echoes.savedEchoes[0].match.matchDay == ld(kOldDay));
}
