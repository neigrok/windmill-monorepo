#include "products/journal/domain/EchoSelection.h"

#include "test/testing.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

using namespace wm;

namespace {

// Every test reads its dates against one trigger day, and every age that matters to a result is
// asserted with daysBetween in the test itself — no hand-picked date is taken on trust.
const std::string kToday = "2026-07-20";

// The trigger and its candidates share exactly one low-frequency word, "rust". Everything else on
// both sides is on the stoplist, so a test that means to exercise ranking never quietly exercises
// the anchor rule as well.
const std::string kTriggerText = "i want to learn rust with marta";
const std::string kAnchoredText = "the rust compiler again";

Vectored span(std::int64_t spanId, const std::string& iso, std::vector<float> vector,
              const std::string& text = kAnchoredText) {
  return Vectored{spanId, LocalDate{iso}, text, std::move(vector)};
}

// A unit vector `degrees` off the first axis: cosine between at(x) and at(y) is cos(x - y), so a
// test states the similarity it wants in degrees and reads it straight back.
std::vector<float> at(double degrees) {
  const double radians = degrees * 3.14159265358979323846 / 180.0;
  return {static_cast<float>(std::cos(radians)), static_cast<float>(std::sin(radians))};
}

// One-hot axes are mutually orthogonal, so candidates built from them form no families and carry no
// diversity penalty — a quota rule can then be measured with nothing else moving.
std::vector<float> axis(std::size_t dimensions, std::size_t which) {
  std::vector<float> out(dimensions, 0.0f);
  out[which] = 1.0f;
  return out;
}

// The same unit circle in three dimensions, so a test can spread a family across the x-y plane and
// then put one more candidate out of that plane entirely — near the trigger, far from the family.
std::vector<float> inPlane(double degrees) {
  const std::vector<float> flat = at(degrees);
  return {flat[0], flat[1], 0.0f};
}
std::vector<float> lifted(double cosineToTrigger) {
  return {static_cast<float>(cosineToTrigger), 0.0f,
          static_cast<float>(std::sqrt(1.0 - cosineToTrigger * cosineToTrigger))};
}

std::vector<std::int64_t> matchIds(const std::vector<Pairing>& pairings) {
  std::vector<std::int64_t> ids;
  for (const Pairing& pairing : pairings) ids.push_back(pairing.matchSpanId);
  return ids;
}

}

// ---- cosine -----------------------------------------------------------------------------------

TEST(cosine_is_one_for_identical_vectors_and_zero_for_orthogonal_ones) {
  CHECK(cosine({1.0f, 2.0f, 3.0f}, {1.0f, 2.0f, 3.0f}) > 0.9999f);
  CHECK(cosine({1.0f, 2.0f, 3.0f}, {1.0f, 2.0f, 3.0f}) <= 1.0f);    // the declared range holds
  CHECK_EQ(cosine({2.0f, 4.0f, 6.0f}, {1.0f, 2.0f, 3.0f}), 1.0f);   // scale is not direction
  CHECK_EQ(cosine({1.0f, 0.0f}, {0.0f, 1.0f}), 0.0f);
  CHECK(std::abs(cosine(at(0.0), at(60.0)) - 0.5f) < 1e-5f);
}

TEST(mismatched_or_zero_norm_vectors_cosine_to_zero_and_never_divide) {
  CHECK_EQ(cosine({1.0f, 0.0f, 0.0f}, {1.0f, 0.0f}), 0.0f);   // not comparable at all
  CHECK_EQ(cosine({1.0f, 0.0f}, {}), 0.0f);
  CHECK_EQ(cosine({}, {}), 0.0f);
  CHECK_EQ(cosine({0.0f, 0.0f}, {1.0f, 0.0f}), 0.0f);         // zero norm, guarded
  CHECK_EQ(cosine({1.0f, 0.0f}, {0.0f, 0.0f}), 0.0f);
  CHECK_EQ(cosine({0.0f, 0.0f}, {0.0f, 0.0f}), 0.0f);
  CHECK_EQ(cosine({1.0f, 0.0f}, {-1.0f, 0.0f}), 0.0f);        // opposed is not near
}

// ---- daysBetween ------------------------------------------------------------------------------

TEST(days_between_crosses_a_leap_day_and_a_year_boundary_in_both_directions) {
  CHECK_EQ(daysBetween(LocalDate{"2024-02-28"}, LocalDate{"2024-03-01"}), 2L);   // 29 Feb exists
  CHECK_EQ(daysBetween(LocalDate{"2023-02-28"}, LocalDate{"2023-03-01"}), 1L);   // here it does not
  CHECK_EQ(daysBetween(LocalDate{"2024-03-01"}, LocalDate{"2024-02-28"}), -2L);
  CHECK_EQ(daysBetween(LocalDate{"2023-12-31"}, LocalDate{"2024-01-01"}), 1L);
  CHECK_EQ(daysBetween(LocalDate{"2024-01-01"}, LocalDate{"2023-12-31"}), -1L);
  CHECK_EQ(daysBetween(LocalDate{"2024-01-01"}, LocalDate{"2025-01-01"}), 366L);
  CHECK_EQ(daysBetween(LocalDate{"2025-01-01"}, LocalDate{"2026-01-01"}), 365L);
  CHECK_EQ(daysBetween(LocalDate{"2000-02-29"}, LocalDate{"2100-02-28"}), 36524L);   // 2100: no leap
  CHECK_EQ(daysBetween(LocalDate{kToday}, LocalDate{kToday}), 0L);
}

// ---- sharesAnchor -----------------------------------------------------------------------------

TEST(a_shared_name_is_an_anchor) {
  CHECK(sharesAnchor("marta said she would come by after work",
                     "ran into marta at the station this evening"));
  CHECK(sharesAnchor("MARTA again", "marta"));   // case is folded for comparison only
}

TEST(two_passages_of_nothing_but_common_words_share_no_anchor) {
  // "he was awful again tonight. i just went to bed." is the case this rule exists for: written
  // eighteen months apart about two different men it sits at near-identical cosine and offers the
  // reader nothing to check. Take out the two content words and no anchor is left to find.
  CHECK_FALSE(sharesAnchor("he was again today and i did not know what to say",
                           "she was like that again tonight and i just could not think"));
  CHECK_FALSE(sharesAnchor("i think about it all the time", "we know that they will do it again"));
  CHECK_FALSE(sharesAnchor("", "marta"));
  CHECK_FALSE(sharesAnchor("marta", ""));
  CHECK_FALSE(sharesAnchor("...", "!!!"));
}

TEST(overlapping_only_on_common_words_is_not_an_anchor_even_when_both_have_content) {
  // Both sides carry real content words; they simply do not carry the SAME one. Everything the two
  // do share — the, was, this, morning — is on the list.
  CHECK_FALSE(sharesAnchor("the kitchen was cold this morning",
                           "the office was loud this morning"));
}

TEST(a_shared_number_is_an_anchor) {
  CHECK(sharesAnchor("i turned 30 last week", "30 of them came"));
  CHECK_FALSE(sharesAnchor("i turned 30 last week", "31 of them came"));
}

TEST(the_owners_own_c_plus_plus_example_anchors) {
  // ECHOES.md claims this pair survives the anchor rule. Splitting on non-alphanumerics leaves the
  // token "c", which is on nobody's list of common words, so it does.
  CHECK(sharesAnchor("i want to learn c++.", "i like c++."));
}

// ---- isRefrain --------------------------------------------------------------------------------

TEST(a_trigger_is_a_refrain_at_exactly_the_crowd_threshold_and_not_one_below_it) {
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);
  const SelectionRules rules;   // refrainRadius 0.80, refrainCrowd 5

  // 36 degrees is cosine 0.809, inside the radius. 37 degrees is 0.799, outside it.
  std::vector<Vectored> corpus;
  for (int i = 0; i < 4; ++i) corpus.push_back(span(100 + i, "2026-01-01", at(36.0)));
  for (int i = 0; i < 9; ++i) corpus.push_back(span(200 + i, "2026-01-01", at(37.0)));
  CHECK_FALSE(isRefrain(trigger, corpus, rules));   // four neighbours, and nine that do not count

  corpus.push_back(span(104, "2026-01-01", at(36.0)));
  CHECK(isRefrain(trigger, corpus, rules));         // the fifth tips it

  CHECK_FALSE(isRefrain(trigger, {}, rules));
}

TEST(a_passage_is_not_its_own_neighbour_in_the_crowd) {
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);
  const SelectionRules rules;

  // The trigger's own row is in the corpus, as it is whenever a caller hands over the whole
  // journal. Counting it would make four neighbours read as five and silence a passage that is
  // not a refrain at all.
  std::vector<Vectored> corpus{trigger};
  for (int i = 0; i < 4; ++i) corpus.push_back(span(100 + i, "2026-01-01", at(10.0)));

  CHECK_FALSE(isRefrain(trigger, corpus, rules));
}

// ---- stratify ---------------------------------------------------------------------------------

TEST(a_candidate_inside_the_minimum_day_gap_is_never_retrieved) {
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);
  const std::vector<Vectored> corpus{
      span(10, "2026-07-17", at(0.0)),   // 3 days — identical, and still not an echo
      span(11, "2026-07-14", at(0.0)),   // 6 days
      span(12, "2026-07-13", at(0.0)),   // 7 days — the gap is inclusive
  };
  CHECK_EQ(daysBetween(LocalDate{"2026-07-17"}, LocalDate{kToday}), 3L);
  CHECK_EQ(daysBetween(LocalDate{"2026-07-14"}, LocalDate{kToday}), 6L);
  CHECK_EQ(daysBetween(LocalDate{"2026-07-13"}, LocalDate{kToday}), 7L);

  const std::vector<Vectored> retrieved = stratify(trigger, corpus, SelectionRules{});

  REQUIRE_EQ(retrieved.size(), std::size_t{1});
  CHECK_EQ(retrieved[0].spanId, std::int64_t{12});
}

TEST(the_bands_split_on_day_counts_and_each_contributes_at_most_perBand) {
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);
  SelectionRules rules;
  rules.perBand = 1;

  // One candidate on each side of every band edge, all at the same cosine, so the only things that
  // can decide which one leaves a band are the boundary and the older-day tie-break.
  const std::vector<Vectored> corpus{
      span(30, "2026-06-20", at(20.0)),     //   30 days — 7-30d
      span(31, "2026-06-19", at(20.0)),     //   31 days — 1-3mo
      span(91, "2026-04-20", at(20.0)),     //   91 days — 1-3mo, and the older of the two
      span(92, "2026-04-19", at(20.0)),     //   92 days — 3-12mo
      span(365, "2025-07-20", at(20.0)),    //  365 days — 3-12mo, and the older of the two
      span(366, "2025-07-19", at(20.0)),    //  366 days — 1-3y
      span(1095, "2023-07-21", at(20.0)),   // 1095 days — 1-3y, and the older of the two
      span(1096, "2023-07-20", at(20.0)),   // 1096 days — 3y+
  };
  CHECK_EQ(daysBetween(LocalDate{"2026-06-20"}, LocalDate{kToday}), 30L);
  CHECK_EQ(daysBetween(LocalDate{"2026-06-19"}, LocalDate{kToday}), 31L);
  CHECK_EQ(daysBetween(LocalDate{"2026-04-20"}, LocalDate{kToday}), 91L);
  CHECK_EQ(daysBetween(LocalDate{"2026-04-19"}, LocalDate{kToday}), 92L);
  CHECK_EQ(daysBetween(LocalDate{"2025-07-20"}, LocalDate{kToday}), 365L);
  CHECK_EQ(daysBetween(LocalDate{"2025-07-19"}, LocalDate{kToday}), 366L);
  CHECK_EQ(daysBetween(LocalDate{"2023-07-21"}, LocalDate{kToday}), 1095L);
  CHECK_EQ(daysBetween(LocalDate{"2023-07-20"}, LocalDate{kToday}), 1096L);

  const std::vector<Vectored> retrieved = stratify(trigger, corpus, rules);

  REQUIRE_EQ(retrieved.size(), std::size_t{5});   // five bands, one apiece, youngest band first
  CHECK_EQ(retrieved[0].spanId, std::int64_t{30});
  CHECK_EQ(retrieved[1].spanId, std::int64_t{91});
  CHECK_EQ(retrieved[2].spanId, std::int64_t{365});
  CHECK_EQ(retrieved[3].spanId, std::int64_t{1095});
  CHECK_EQ(retrieved[4].spanId, std::int64_t{1096});
}

TEST(a_band_takes_its_top_perBand_by_cosine) {
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);
  SelectionRules rules;
  rules.perBand = 2;

  const std::vector<Vectored> corpus{
      span(10, "2026-07-01", at(50.0)),   // 19 days — 7-30d band
      span(11, "2026-07-02", at(10.0)),   // 18 days — closest of the band
      span(12, "2026-07-03", at(20.0)),   // 17 days — second closest
      span(13, "2026-07-04", at(70.0)),   // 16 days
      span(20, "2026-02-01", at(60.0)),   // 3-12mo band
      span(21, "2026-02-02", at(15.0)),   // closest of the band
      span(22, "2026-02-03", at(25.0)),   // second closest
  };

  const std::vector<Vectored> retrieved = stratify(trigger, corpus, rules);

  REQUIRE_EQ(retrieved.size(), std::size_t{4});
  CHECK_EQ(retrieved[0].spanId, std::int64_t{11});
  CHECK_EQ(retrieved[1].spanId, std::int64_t{12});
  CHECK_EQ(retrieved[2].spanId, std::int64_t{21});
  CHECK_EQ(retrieved[3].spanId, std::int64_t{22});
}

TEST(a_lone_four_year_old_candidate_survives_forty_recent_ones) {
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);
  const SelectionRules rules;   // perBand 8

  // Forty candidates inside the last month, every one closer to the trigger than the old passage.
  // A flat top-8 over this corpus returns nothing but July; the bands hand 3y+ its own shelf.
  std::vector<Vectored> corpus;
  for (int i = 0; i < 40; ++i)
    corpus.push_back(span(100 + i, "2026-07-0" + std::to_string(1 + i % 9), at(5.0)));
  corpus.push_back(span(999, "2022-07-20", at(45.0)));
  CHECK_EQ(daysBetween(LocalDate{"2022-07-20"}, LocalDate{kToday}), 1461L);

  const std::vector<Vectored> retrieved = stratify(trigger, corpus, rules);

  REQUIRE_EQ(retrieved.size(), std::size_t{9});          // eight out of 7-30d, one out of 3y+
  CHECK_EQ(retrieved[8].spanId, std::int64_t{999});
}

// ---- select -----------------------------------------------------------------------------------

TEST(a_restatement_is_dropped_and_the_memory_beside_it_is_kept) {
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);
  const std::vector<Vectored> candidates{
      span(11, "2026-01-10", {1.0f, 0.01f}),   // cosine 0.99995 — the same sentence again
      span(12, "2026-01-11", at(25.0)),        // cosine 0.906 — a memory
  };

  const std::vector<Pairing> pairings = select(trigger, candidates, SelectionRules{});

  REQUIRE_EQ(pairings.size(), std::size_t{1});
  CHECK_EQ(pairings[0].triggerSpanId, std::int64_t{1});
  CHECK_EQ(pairings[0].matchSpanId, std::int64_t{12});
  CHECK_EQ(pairings[0].familySize, 1);
  CHECK(std::abs(pairings[0].cosine - 0.9063f) < 1e-3f);
}

TEST(a_candidate_sharing_no_anchor_with_the_trigger_is_dropped_however_close_it_sits) {
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);   // anchors: learn, rust, marta
  const std::vector<Vectored> candidates{
      // Both sit close to the trigger and well short of restatement, so the anchor rule is the only
      // thing that can drop them — one has different anchors, the other has none at all.
      span(11, "2026-01-10", at(20.0), "the kitchen was cold this morning"),   // kitchen, cold
      span(12, "2026-01-11", at(25.0), "she was like that again tonight and i just could not think"),
  };
  CHECK(cosine(at(0.0), at(20.0)) < SelectionRules{}.restatement);
  CHECK(cosine(at(0.0), at(25.0)) < SelectionRules{}.restatement);

  CHECK_EQ(select(trigger, candidates, SelectionRules{}).size(), std::size_t{0});
  CHECK_EQ(select(trigger, {}, SelectionRules{}).size(), std::size_t{0});
}

TEST(ten_near_identical_candidates_collapse_into_one_family_led_by_the_oldest) {
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);

  // Every pair sits within 3.6 degrees of every other, far inside familyRadius 0.85 — and the
  // OLDEST is deliberately the FURTHEST from the trigger, so only the age rule can elect it.
  const std::vector<Vectored> candidates{
      span(10, "2024-02-14", at(23.6)),   // the oldest, and the weakest cosine of the ten
      span(11, "2024-03-14", at(23.2)),
      span(12, "2024-04-14", at(22.8)),
      span(13, "2024-05-14", at(22.4)),
      span(14, "2024-06-14", at(22.0)),
      span(15, "2024-07-14", at(21.6)),
      span(16, "2024-08-14", at(21.2)),
      span(17, "2024-09-14", at(20.8)),
      span(18, "2024-10-14", at(20.4)),
      span(19, "2024-11-14", at(20.0)),   // the newest, and the closest
  };

  const std::vector<Pairing> pairings = select(trigger, candidates, SelectionRules{});

  REQUIRE_EQ(pairings.size(), std::size_t{1});
  CHECK_EQ(pairings[0].matchSpanId, std::int64_t{10});
  CHECK_EQ(pairings[0].familySize, 10);
  CHECK(std::abs(pairings[0].cosine - 0.9164f) < 1e-3f);
}

TEST(at_most_two_of_the_shown_set_come_from_the_last_thirty_days) {
  // Seven mutually orthogonal candidates: no families, no diversity penalty, and a cosine to the
  // trigger that falls off in span-id order. The four closest are all inside the last month.
  const Vectored trigger =
      Vectored{1, LocalDate{kToday}, kTriggerText, {6.0f, 5.0f, 4.0f, 3.0f, 2.0f, 1.0f, 0.5f}};
  const std::vector<Vectored> candidates{
      span(11, "2026-07-10", axis(7, 0)),   //  10 days
      span(12, "2026-07-05", axis(7, 1)),   //  15 days
      span(13, "2026-06-30", axis(7, 2)),   //  20 days
      span(14, "2026-06-25", axis(7, 3)),   //  25 days
      span(15, "2025-06-15", axis(7, 4)),   // 400 days
      span(16, "2024-06-15", axis(7, 5)),   // 765 days
      span(17, "2026-06-10", axis(7, 6)),   //  40 days — just outside the window, and last on score
  };
  CHECK_EQ(daysBetween(LocalDate{"2026-07-10"}, LocalDate{kToday}), 10L);
  CHECK_EQ(daysBetween(LocalDate{"2026-06-25"}, LocalDate{kToday}), 25L);
  CHECK_EQ(daysBetween(LocalDate{"2026-06-10"}, LocalDate{kToday}), 40L);
  CHECK_EQ(daysBetween(LocalDate{"2025-06-15"}, LocalDate{kToday}), 400L);
  CHECK_EQ(daysBetween(LocalDate{"2024-06-15"}, LocalDate{kToday}), 765L);

  const std::vector<Pairing> pairings = select(trigger, candidates, SelectionRules{});

  // Spans 13 and 14 outrank every old candidate on every term and are refused anyway — the quota
  // is full. Span 17 is the weakest of the whole set and is shown, because forty days is not the
  // last thirty: the window the quota governs is a real edge, not a vague sense of recency.
  CHECK_EQ(matchIds(pairings), (std::vector<std::int64_t>{11, 12, 15, 16, 17}));
  CHECK(pairings[0].score > pairings[1].score);
  CHECK(pairings[1].score > pairings[2].score);
  CHECK(pairings[2].score > pairings[3].score);
  CHECK(pairings[3].score > pairings[4].score);
}

TEST(at_most_two_of_the_shown_set_come_from_any_one_calendar_month) {
  const Vectored trigger =
      Vectored{1, LocalDate{kToday}, kTriggerText, {5.0f, 4.0f, 3.0f, 2.0f, 1.0f}};
  const std::vector<Vectored> candidates{
      span(11, "2024-03-05", axis(5, 0)),   // four in March 2024, ranked 11 > 12 > 13 > 14
      span(12, "2024-03-10", axis(5, 1)),
      span(13, "2024-03-15", axis(5, 2)),
      span(14, "2024-03-20", axis(5, 3)),
      span(15, "2024-01-10", axis(5, 4)),   // the weakest cosine, and the only January
  };

  const std::vector<Pairing> pairings = select(trigger, candidates, SelectionRules{});

  CHECK_EQ(matchIds(pairings), (std::vector<std::int64_t>{11, 12, 15}));
  CHECK(pairings[0].score > pairings[1].score);
  CHECK(pairings[1].score > pairings[2].score);
}

TEST(the_diversity_penalty_demotes_a_near_twin_of_what_is_already_chosen) {
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, {1.0f, 0.0f, 0.0f}};
  const std::vector<Vectored> candidates{
      span(11, "2025-06-15", inPlane(25.0)),   // 400 days, cosine 0.906 — the runaway winner
      span(12, "2024-06-15", inPlane(62.0)),   // 765 days, cosine 0.469, and 0.799 to span 11
      span(13, "2024-06-16", lifted(0.45)),    // 764 days, cosine 0.450, and 0.408 to span 11
  };
  // Close to span 11 but not close enough to join its family, which is exactly the case the
  // diversity term exists for: a second card that adds nothing the first did not already say.
  CHECK(cosine(inPlane(25.0), inPlane(62.0)) < SelectionRules{}.familyRadius);

  const std::vector<Pairing> pairings = select(trigger, candidates, SelectionRules{});

  // On raw score span 12 beats span 13. Measured against what is already on the page it does not.
  CHECK_EQ(matchIds(pairings), (std::vector<std::int64_t>{11, 13, 12}));
  CHECK(pairings[1].score > pairings[2].score);
}

TEST(a_representative_standing_for_eight_near_copies_is_outranked_by_a_lone_passage) {
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, {1.0f, 0.0f, 0.0f}};

  // Eight candidates spread across ten degrees — one family, since the widest pair still cosines
  // 0.985 — and one passage of its own, lifted out of their plane so it can never join them.
  const std::vector<Vectored> candidates{
      span(11, "2024-06-15", inPlane(44.29)),   // the oldest of the eight: cosine 0.716
      span(12, "2024-07-01", inPlane(40.00)),   // and the closest of them: cosine 0.766
      span(13, "2024-07-02", inPlane(41.43)),
      span(14, "2024-07-03", inPlane(42.86)),
      span(15, "2024-07-04", inPlane(45.71)),
      span(16, "2024-07-05", inPlane(47.14)),
      span(17, "2024-07-06", inPlane(48.57)),
      span(18, "2024-07-07", inPlane(50.00)),
      span(20, "2024-06-16", lifted(0.706)),    // alone, and slightly FURTHER from the trigger
  };
  CHECK(cosine(inPlane(40.0), inPlane(50.0)) > SelectionRules{}.familyRadius);
  CHECK(cosine(inPlane(40.0), lifted(0.706)) < SelectionRules{}.familyRadius);

  const std::vector<Pairing> pairings = select(trigger, candidates, SelectionRules{});

  // Span 11 is nearer the trigger than span 20 and still loses: it is really eight near-copies
  // wearing one face, and the ranking discounts it for that.
  CHECK_EQ(matchIds(pairings), (std::vector<std::int64_t>{20, 11}));
  CHECK_EQ(pairings[0].familySize, 1);
  CHECK_EQ(pairings[1].familySize, 8);
  CHECK(pairings[1].cosine > pairings[0].cosine);
}

TEST(the_oldest_qualifying_candidate_is_swapped_in_when_the_ranking_would_drop_it) {
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, {3.0f, 2.0f, 1.0f}};
  const std::vector<Vectored> candidates{
      span(11, "2026-04-11", axis(3, 0)),   // 100 days, the strongest score
      span(12, "2026-01-01", axis(3, 1)),   // 200 days, second
      span(13, "2025-09-23", axis(3, 2)),   // 300 days, the oldest and the weakest
  };
  CHECK_EQ(daysBetween(LocalDate{"2026-04-11"}, LocalDate{kToday}), 100L);
  CHECK_EQ(daysBetween(LocalDate{"2026-01-01"}, LocalDate{kToday}), 200L);
  CHECK_EQ(daysBetween(LocalDate{"2025-09-23"}, LocalDate{kToday}), 300L);

  SelectionRules roomForThree;
  roomForThree.shown = 3;
  SelectionRules roomForTwo;
  roomForTwo.shown = 2;

  // With room for everyone the ranking speaks for itself.
  CHECK_EQ(matchIds(select(trigger, candidates, roomForThree)),
           (std::vector<std::int64_t>{11, 12, 13}));

  // With room for two the ranking would take 11 and 12 — and span 13 takes span 12's slot anyway,
  // because the first time someone wrote a thing is the payload.
  CHECK_EQ(matchIds(select(trigger, candidates, roomForTwo)), (std::vector<std::int64_t>{11, 13}));
}

TEST(identical_inputs_yield_identical_pairings_down_to_the_tie_break) {
  // All three cosines are exactly 0.5, so the standard deviation is zero, the z guard fires and
  // every z is 0. Spans 11 and 12 then tie on score outright and can only be split by the tail:
  // the older day, then the span id. The input is deliberately out of order.
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, {1.0f, 1.0f, 1.0f, 1.0f}};
  const std::vector<Vectored> candidates{
      span(12, "2025-01-10", axis(4, 1)),
      span(13, "2025-03-10", axis(4, 2)),
      span(11, "2025-01-10", axis(4, 0)),
  };

  const std::vector<Pairing> first = select(trigger, candidates, SelectionRules{});
  const std::vector<Pairing> second = select(trigger, candidates, SelectionRules{});

  CHECK_EQ(matchIds(first), (std::vector<std::int64_t>{11, 12, 13}));
  REQUIRE_EQ(first.size(), second.size());
  for (std::size_t i = 0; i < first.size(); ++i) {
    CHECK_EQ(first[i].triggerSpanId, second[i].triggerSpanId);
    CHECK_EQ(first[i].matchSpanId, second[i].matchSpanId);
    CHECK_EQ(first[i].cosine, second[i].cosine);
    CHECK_EQ(first[i].score, second[i].score);
    CHECK_EQ(first[i].familySize, second[i].familySize);
  }
  CHECK_EQ(first[0].cosine, 0.5f);
  CHECK_EQ(first[0].score, first[1].score);   // the tie is real, not an artefact of rounding
  CHECK(first[1].score > first[2].score);
}

TEST(fourteen_fortnight_old_near_copies_do_not_bury_one_genuine_match_from_two_years_back) {
  // The headline. The trigger sits a fortnight into a run of near-identical nights; the passage the
  // feature exists for is two years old and less similar than every single one of them.
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, {1.0f, 0.0f, 0.0f}};

  const std::string fortnight[] = {"2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03",
                                   "2026-07-04", "2026-07-05", "2026-07-06", "2026-07-07",
                                   "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11",
                                   "2026-07-12", "2026-07-13"};
  std::vector<Vectored> candidates;
  for (int i = 0; i < 14; ++i)
    candidates.push_back(span(100 + i, fortnight[i],
                              {0.95f, static_cast<float>(0.30 + 0.005 * i), 0.0f}));
  candidates.push_back(span(999, "2024-07-20", {0.72f, 0.0f, 0.6941f}));
  CHECK_EQ(daysBetween(LocalDate{"2026-06-30"}, LocalDate{kToday}), 20L);
  CHECK_EQ(daysBetween(LocalDate{"2026-07-13"}, LocalDate{kToday}), 7L);
  CHECK_EQ(daysBetween(LocalDate{"2024-07-20"}, LocalDate{kToday}), 730L);

  const std::vector<Pairing> pairings = select(trigger, candidates, SelectionRules{});

  // Two pairings, not ten: the fortnight is one family standing behind its oldest member, and the
  // two-year-old passage keeps a slot of its own.
  CHECK_EQ(matchIds(pairings), (std::vector<std::int64_t>{100, 999}));
  CHECK_EQ(pairings[0].familySize, 14);
  CHECK_EQ(pairings[1].familySize, 1);
  CHECK(std::abs(pairings[1].cosine - 0.72f) < 1e-3f);
}

// The trace half. Every rule below already had a test asserting WHAT it selects; these assert that
// it also says WHY, because the debug door is only worth having if its reasons are the real ones.

namespace {

// What the trace says became of one candidate, as the debug door would print it. "no note" rather
// than a crash when the span is absent, so a broken expectation reads as a wrong word.
std::string fateOf(const TriggerTrace& trace, std::int64_t spanId) {
  for (const CandidateNote& note : trace.notes)
    if (note.spanId == spanId) return fateText(note.fate);
  return "no note";
}

long ageOf(const TriggerTrace& trace, std::int64_t spanId) {
  for (const CandidateNote& note : trace.notes)
    if (note.spanId == spanId) return note.ageDays;
  return -1;
}

}

TEST(explained_selection_names_the_rule_that_dropped_each_candidate) {
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, axis(4, 0)};
  const std::vector<Vectored> candidates{
      span(10, "2026-01-01", axis(4, 0), kTriggerText),                    // the same sentence again
      span(11, "2026-01-02", {0.7f, 0.714f, 0.0f, 0.0f}, "i want to get the thing again"),
      span(12, "2025-06-01", {0.6f, 0.0f, 0.8f, 0.0f}, kAnchoredText)};

  const Selection selection = selectExplained(trigger, candidates, SelectionRules{});

  CHECK_EQ(matchIds(selection.pairings), (std::vector<std::int64_t>{12}));
  CHECK_EQ(selection.notes.size(), std::size_t{3});
  CHECK_EQ(std::string{fateText(selection.notes[0].fate)}, std::string{"restatement"});
  CHECK_EQ(std::string{fateText(selection.notes[1].fate)}, std::string{"no_anchor"});
  CHECK_EQ(std::string{fateText(selection.notes[2].fate)}, std::string{"selected"});
  CHECK(std::abs(selection.notes[2].score - selection.pairings[0].score) < 1e-6);
  // And the reasons are the same list `select` returns, never a second opinion about it.
  CHECK_EQ(matchIds(select(trigger, candidates, SelectionRules{})),
           matchIds(selection.pairings));
}

TEST(a_refrain_emits_nothing_and_the_trace_still_says_how_crowded_it_was) {
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, axis(4, 0)};
  std::vector<Vectored> history;
  for (int i = 0; i < 5; ++i)
    history.push_back(span(100 + i, "2026-01-0" + std::to_string(i + 1), axis(4, 0)));

  const PageSelection page = selectForPage({trigger}, history, {}, SelectionRules{}, 10);

  CHECK(page.pairings.empty());
  CHECK_EQ(page.refrains, 1);
  CHECK_EQ(page.traces.size(), std::size_t{1});
  CHECK_EQ(page.traces[0].crowd, 5);
  CHECK_EQ(page.traces[0].refrain, true);
  CHECK_EQ(page.traces[0].history, 5);
}

TEST(the_page_ceiling_and_the_readers_dismissal_are_both_written_onto_the_notes) {
  // Two triggers on one page, each with exactly one candidate it can anchor to: candidate 10
  // shares "rust" with the first and nothing with the second, candidate 11 the other way round.
  const Vectored first = Vectored{1, LocalDate{kToday}, kTriggerText, axis(4, 0)};
  const Vectored second = Vectored{2, LocalDate{kToday}, "the piano scales sound wrong", axis(4, 1)};
  const std::vector<Vectored> history{
      span(10, "2025-06-01", {0.9f, 0.0f, 0.436f, 0.0f}, kAnchoredText),
      span(11, "2025-06-02", {0.0f, 0.6f, 0.0f, 0.8f}, "piano scales, badly")};

  const PageSelection full = selectForPage({first, second}, history, {}, SelectionRules{}, 10);
  CHECK_EQ(full.pairings.size(), std::size_t{2});
  CHECK_EQ(full.cappedOut, 0);
  CHECK_EQ(fateOf(full.traces[0], 10), std::string{"selected"});
  CHECK_EQ(fateOf(full.traces[0], 11), std::string{"no_anchor"});

  // One slot for the page, so the weaker of the two pairings is cut and says so.
  const PageSelection capped = selectForPage({first, second}, history, {}, SelectionRules{}, 1);
  CHECK_EQ(capped.pairings.size(), std::size_t{1});
  CHECK_EQ(capped.cappedOut, 1);
  const bool firstKept = capped.pairings[0].triggerSpanId == 1;
  CHECK_EQ(fateOf(capped.traces[firstKept ? 1 : 0], firstKept ? 11 : 10), std::string{"page_cap"});

  // And a pairing the reader waved away is gone from the proposal and named as dismissed.
  const PageSelection waved =
      selectForPage({first, second}, history, {{1, 10}}, SelectionRules{}, 10);
  CHECK_EQ(waved.pairings.size(), std::size_t{1});
  CHECK_EQ(waved.pairings[0].triggerSpanId, std::int64_t{2});
  CHECK_EQ(fateOf(waved.traces[0], 10), std::string{"dismissed"});
}

TEST(near_misses_are_reported_only_when_asked_for) {
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, axis(4, 0)};
  // Two days old — inside minDayGap, so retrieval never hands it over and no rule below ever sees
  // it. Without the near misses a debug run would show nothing at all about the closest passage
  // in the corpus.
  const std::vector<Vectored> history{
      span(10, "2026-07-18", {0.99f, 0.141f, 0.0f, 0.0f}, kAnchoredText)};
  CHECK_EQ(daysBetween(LocalDate{"2026-07-18"}, LocalDate{kToday}), 2L);

  const PageSelection silent = selectForPage({trigger}, history, {}, SelectionRules{}, 10, 0);
  CHECK(silent.traces[0].notes.empty());
  CHECK_EQ(silent.traces[0].retrieved, 0);

  const PageSelection asked = selectForPage({trigger}, history, {}, SelectionRules{}, 10, 5);
  CHECK_EQ(asked.traces[0].notes.size(), std::size_t{1});
  CHECK_EQ(fateOf(asked.traces[0], 10), std::string{"not_retrieved"});
  CHECK_EQ(ageOf(asked.traces[0], 10), 2L);
  CHECK(asked.pairings.empty());
}
