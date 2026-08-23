#include "products/journal/application/WarmEchoRepository.h"

#include "products/journal/application/EchoSweep.h"
#include "test/platform/Fakes.h"
#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <string>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

constexpr std::uint64_t kTtlMs = 15 * 60 * 1000;

const std::string kJanuary = "2026-01-01";
const std::string kMay = "2026-05-01";
const std::string kJanuaryLine = "i want to learn kotlin properly this time.";
const std::string kMayLine = "i like kotlin now and the work is fun.";

// Two derived pages behind storage: the May page is planted first, so insertion order would be caught by the first assertion.
void plantTwoPages(FakeEchoRepository& storage, FakeEmbedder& embedder) {
  storage.plantSpan(uid("u1"), ld(kMay), 22, kMayLine, embedder.embed({kMayLine})[0]);
  storage.plantSpan(uid("u1"), ld(kJanuary), 11, kJanuaryLine, embedder.embed({kJanuaryLine})[0]);
}

void checkSame(const std::vector<Vectored>& got, const std::vector<Vectored>& want) {
  REQUIRE_EQ(got.size(), want.size());
  for (std::size_t at = 0; at < want.size(); ++at) {
    CHECK_EQ(got[at].spanId, want[at].spanId);
    CHECK(got[at].day == want[at].day);
    CHECK_EQ(got[at].text, want[at].text);
    CHECK(got[at].vector == want[at].vector);
  }
}

}

TEST(a_second_derivation_is_served_from_the_warm_corpus_without_reloading_it) {
  FakeEchoRepository storage;
  FakeEmbedder embedder;
  FakeClock clock;
  plantTwoPages(storage, embedder);
  WarmEchoRepository warm{storage, clock, kTtlMs};

  const std::vector<Vectored> first = warm.corpusOf(uid("u1"), "fake-embedder-v1");
  const std::vector<Vectored> second = warm.corpusOf(uid("u1"), "fake-embedder-v1");

  CHECK_EQ(storage.corpusLoads, 1);
  CHECK_EQ(warm.loads(), 1);
  REQUIRE_EQ(first.size(), std::size_t{2});
  CHECK_EQ(first[0].spanId, std::int64_t{11});
  CHECK_EQ(first[1].spanId, std::int64_t{22});
  checkSame(second, first);
}

// Every derivation rewrites its own page's passages, which is why replaceSpans hands back what it stored.
TEST(a_re_derived_page_moves_the_warm_corpus_rather_than_emptying_it) {
  FakeEchoRepository storage;
  FakeEmbedder embedder;
  FakeClock clock;
  plantTwoPages(storage, embedder);
  WarmEchoRepository warm{storage, clock, kTtlMs};
  warm.corpusOf(uid("u1"), "fake-embedder-v1");

  const std::string rewritten = "i like kotlin now, and the work is finally fun.";
  warm.replaceSpans(uid("u1"), ld(kMay),
                    {SpanWrite{22, Passage{0, 0, static_cast<int>(rewritten.size()), rewritten},
                               embedder.embed({rewritten})[0]}},
                    "fake-embedder-v1", 7);

  const std::vector<Vectored> after = warm.corpusOf(uid("u1"), "fake-embedder-v1");
  CHECK_EQ(storage.corpusLoads, 1);   // still warm — the page moved, the corpus did not reload
  CHECK_EQ(after.size(), std::size_t{2});
  CHECK_EQ(after[1].text, rewritten);
  checkSame(after, storage.corpusOf(uid("u1"), "fake-embedder-v1"));
}

// A page whose body was emptied leaves the corpus entirely, or a deleted page goes on echoing.
TEST(a_page_emptied_of_passages_leaves_the_warm_corpus) {
  FakeEchoRepository storage;
  FakeEmbedder embedder;
  FakeClock clock;
  plantTwoPages(storage, embedder);
  WarmEchoRepository warm{storage, clock, kTtlMs};
  warm.corpusOf(uid("u1"), "fake-embedder-v1");

  warm.replaceSpans(uid("u1"), ld(kMay), {}, "fake-embedder-v1", 7);

  const std::vector<Vectored> after = warm.corpusOf(uid("u1"), "fake-embedder-v1");
  REQUIRE_EQ(after.size(), std::size_t{1});
  CHECK_EQ(after[0].spanId, std::int64_t{11});
  CHECK_EQ(storage.corpusLoads, 1);
}

// Cosine across two embedding spaces is meaningless, so a write in another space drops the warm copy outright.
TEST(a_write_in_another_embedding_version_drops_the_warm_corpus) {
  FakeEchoRepository storage;
  FakeEmbedder embedder;
  FakeClock clock;
  plantTwoPages(storage, embedder);
  WarmEchoRepository warm{storage, clock, kTtlMs};
  warm.corpusOf(uid("u1"), "fake-embedder-v1");

  warm.replaceSpans(uid("u1"), ld(kMay), {}, "fake-embedder-v2", 7);

  warm.corpusOf(uid("u1"), "fake-embedder-v1");
  CHECK_EQ(storage.corpusLoads, 2);
}

TEST(a_read_of_another_embedding_version_is_never_answered_from_the_warm_copy) {
  FakeEchoRepository storage;
  FakeEmbedder embedder;
  FakeClock clock;
  plantTwoPages(storage, embedder);
  WarmEchoRepository warm{storage, clock, kTtlMs};

  warm.corpusOf(uid("u1"), "fake-embedder-v1");
  CHECK_EQ(warm.corpusOf(uid("u1"), "fake-embedder-v2").size(), std::size_t{0});
  CHECK_EQ(storage.corpusLoads, 2);
}

// The TTL is the bound on a span written by somebody else — a staleness guarantee, not a performance knob.
TEST(a_warm_corpus_older_than_its_ttl_is_loaded_again) {
  FakeEchoRepository storage;
  FakeEmbedder embedder;
  FakeClock clock;
  plantTwoPages(storage, embedder);
  WarmEchoRepository warm{storage, clock, kTtlMs};

  warm.corpusOf(uid("u1"), "fake-embedder-v1");
  clock.now += kTtlMs - 1;
  warm.corpusOf(uid("u1"), "fake-embedder-v1");
  CHECK_EQ(storage.corpusLoads, 1);

  clock.now += 1;
  warm.corpusOf(uid("u1"), "fake-embedder-v1");
  CHECK_EQ(storage.corpusLoads, 2);
}

// One warm copy per account, and never one account's passages answering another's.
TEST(each_account_is_held_warm_on_its_own) {
  FakeEchoRepository storage;
  FakeEmbedder embedder;
  FakeClock clock;
  plantTwoPages(storage, embedder);
  storage.plantSpan(uid("u2"), ld(kJanuary), 33, "something else entirely",
                    embedder.embed({"something else entirely"})[0]);
  WarmEchoRepository warm{storage, clock, kTtlMs};

  CHECK_EQ(warm.corpusOf(uid("u1"), "fake-embedder-v1").size(), std::size_t{2});
  const std::vector<Vectored> other = warm.corpusOf(uid("u2"), "fake-embedder-v1");
  REQUIRE_EQ(other.size(), std::size_t{1});
  CHECK_EQ(other[0].spanId, std::int64_t{33});
  CHECK_EQ(warm.corpusOf(uid("u1"), "fake-embedder-v1").size(), std::size_t{2});
  CHECK_EQ(storage.corpusLoads, 2);
}

TEST(two_derivations_for_one_user_cost_one_corpus_load) {
  FakeEchoRepository storage;
  FakeEmbedder embedder;
  FakeCurator curator;
  FakeClock clock;
  FakeSubscriptionRepository subscriptions;
  FakeAiUsageRepository usage;
  Entitlements entitlements{subscriptions, usage};

  storage.addUser(uid("u1"));
  storage.plantSpan(uid("u1"), ld(kJanuary), 11, kJanuaryLine, embedder.embed({kJanuaryLine})[0]);
  storage.addDuePage(uid("u1"), ld(kMay), kMayLine);
  storage.addDuePage(uid("u1"), ld("2026-06-01"), kMayLine);

  WarmEchoRepository warm{storage, clock, kTtlMs};
  FakeSegmenter segmenter;
  EchoSweep sweep{warm,    segmenter,    embedder,         curator,
                  clock,   entitlements, SelectionRules{}, SweepBudget{}};

  CHECK_EQ(sweep.derivePage(uid("u1"), ld(kMay)).pagesDerived, 1);
  CHECK_EQ(sweep.derivePage(uid("u1"), ld("2026-06-01")).pagesDerived, 1);

  CHECK_EQ(storage.corpusLoads, 1);
  CHECK_EQ(curator.calls, 2);
}

// A cache that only checks expiry on the way IN frees nothing: two accounts go warm, the clock passes the TTL, and a third load must leave the stale ones behind.
TEST(a_corpus_nobody_came_back_for_is_freed_and_not_merely_ignored) {
  FakeEchoRepository storage;
  FakeEmbedder embedder;
  FakeClock clock;
  plantTwoPages(storage, embedder);
  storage.plantSpan(uid("u2"), ld(kJanuary), 33, "something else entirely",
                    embedder.embed({"something else entirely"})[0]);
  storage.plantSpan(uid("u3"), ld(kMay), 44, "a third account writing tonight",
                    embedder.embed({"a third account writing tonight"})[0]);
  WarmEchoRepository warm{storage, clock, kTtlMs};

  warm.corpusOf(uid("u1"), "fake-embedder-v1");
  warm.corpusOf(uid("u2"), "fake-embedder-v1");
  CHECK_EQ(warm.warmUsers(), 2);

  clock.now += kTtlMs + 1;
  warm.corpusOf(uid("u3"), "fake-embedder-v1");

  CHECK_EQ(warm.warmUsers(), 1);
  CHECK_EQ(storage.corpusLoads, 3);

  const std::vector<Vectored> again = warm.corpusOf(uid("u1"), "fake-embedder-v1");
  CHECK_EQ(again.size(), std::size_t{2});
  CHECK_EQ(storage.corpusLoads, 4);
}
