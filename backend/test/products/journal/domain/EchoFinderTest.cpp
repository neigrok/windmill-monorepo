#include "products/journal/domain/EchoFinder.h"

#include "test/products/journal/Fakes.h"
#include "test/testing.h"

#include <optional>
#include <utility>
#include <vector>

using namespace wm;
using namespace wm::fake;

namespace {

EchoCandidate page(const std::string& iso, std::vector<float> vector, const std::string& body) {
  return EchoCandidate{ld(iso), std::move(vector), body};
}

}

TEST(identical_vectors_far_enough_apart_echo_at_full_score) {
  const EchoCandidate trigger = page("2026-07-20", {1.0f, 0.0f, 0.0f}, "today body");
  const std::vector<EchoCandidate> corpus{page("2026-07-01", {1.0f, 0.0f, 0.0f}, "old body")};

  const std::optional<EchoMatch> found = match(trigger, corpus, EchoRules{});

  CHECK(found.has_value());
  CHECK(found->matchDay == ld("2026-07-01"));
  CHECK(found->score > 0.99f);
  CHECK(found->triggerSpan == (std::pair<int, int>{0, 10}));   // "today body"
  CHECK(found->matchSpan == (std::pair<int, int>{0, 8}));      // "old body"
}

TEST(a_dissimilar_older_page_stays_below_threshold_and_does_not_echo) {
  const EchoCandidate trigger = page("2026-07-20", {1.0f, 0.0f}, "a");
  const std::vector<EchoCandidate> corpus{page("2026-07-01", {0.0f, 1.0f}, "b")};   // orthogonal

  CHECK_FALSE(match(trigger, corpus, EchoRules{}).has_value());
}

TEST(a_candidate_within_the_min_day_gap_is_ignored_even_if_identical) {
  const EchoCandidate trigger = page("2026-07-20", {1.0f, 0.0f, 0.0f}, "x");
  // Ten days older is inside the default fourteen-day reach, so yesterday's twin is never an echo.
  const std::vector<EchoCandidate> corpus{page("2026-07-10", {1.0f, 0.0f, 0.0f}, "x")};

  CHECK_FALSE(match(trigger, corpus, EchoRules{}).has_value());
}

TEST(a_same_day_or_newer_candidate_is_ignored) {
  const EchoCandidate trigger = page("2026-07-20", {1.0f, 0.0f, 0.0f}, "x");
  const std::vector<EchoCandidate> corpus{
      page("2026-07-20", {1.0f, 0.0f, 0.0f}, "same day, incl. the trigger's own row"),
      page("2026-07-25", {1.0f, 0.0f, 0.0f}, "newer"),
  };

  CHECK_FALSE(match(trigger, corpus, EchoRules{}).has_value());
}

TEST(the_single_best_of_three_older_pages_is_returned) {
  const EchoCandidate trigger = page("2026-07-20", {1.0f, 1.0f, 0.0f}, "trigger body");
  const std::vector<EchoCandidate> corpus{
      page("2026-06-01", {1.0f, 0.0f, 0.0f}, "aaa"),    // cosine 1/sqrt2 ~ 0.707
      page("2026-06-02", {1.0f, 1.0f, 0.0f}, "bbbb"),   // cosine 1 — the winner
      page("2026-06-03", {0.0f, 1.0f, 0.0f}, "cc"),     // cosine 1/sqrt2 ~ 0.707
  };

  const std::optional<EchoMatch> found = match(trigger, corpus, EchoRules{});

  CHECK(found.has_value());
  CHECK(found->matchDay == ld("2026-06-02"));
  CHECK(found->score > 0.99f);
  CHECK(found->triggerSpan == (std::pair<int, int>{0, 12}));   // "trigger body"
  CHECK(found->matchSpan == (std::pair<int, int>{0, 4}));      // "bbbb"
}

TEST(empty_and_zero_vectors_never_match_and_never_crash) {
  // An empty trigger vector: nothing to read across.
  CHECK_FALSE(match(page("2026-07-20", {}, "x"),
                    {page("2026-06-01", {1.0f, 0.0f}, "y")}, EchoRules{})
                  .has_value());

  // A zero-norm trigger of matching size: cosine is a guarded 0, not a divide-by-zero.
  CHECK_FALSE(match(page("2026-07-20", {0.0f, 0.0f, 0.0f}, "x"),
                    {page("2026-06-01", {1.0f, 0.0f, 0.0f}, "y")}, EchoRules{})
                  .has_value());

  // A candidate of a different dimensionality is not comparable and is skipped.
  CHECK_FALSE(match(page("2026-07-20", {1.0f, 0.0f, 0.0f}, "x"),
                    {page("2026-06-01", {}, "y")}, EchoRules{})
                  .has_value());

  // An empty corpus has nothing to echo.
  CHECK_FALSE(match(page("2026-07-20", {1.0f, 0.0f, 0.0f}, "x"), {}, EchoRules{}).has_value());
}
