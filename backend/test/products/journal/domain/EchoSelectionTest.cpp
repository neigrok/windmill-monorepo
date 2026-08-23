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

const std::string kToday = "2026-07-20";

// Trigger and candidates share exactly one low-frequency word, "rust"; the rest is stoplisted.
const std::string kTriggerText = "i want to learn rust with marta";
const std::string kAnchoredText = "the rust compiler again";

Vectored span(std::int64_t spanId, const std::string& iso, std::vector<float> vector,
              const std::string& text = kAnchoredText) {
  return Vectored{spanId, LocalDate{iso}, text, std::move(vector)};
}

// A unit vector `degrees` off the first axis: cosine between at(x) and at(y) is cos(x - y).
std::vector<float> at(double degrees) {
  const double radians = degrees * 3.14159265358979323846 / 180.0;
  return {static_cast<float>(std::cos(radians)), static_cast<float>(std::sin(radians))};
}

// One-hot axes are mutually orthogonal: no families, no diversity penalty.
std::vector<float> axis(std::size_t dimensions, std::size_t which) {
  std::vector<float> out(dimensions, 0.0f);
  out[which] = 1.0f;
  return out;
}

// The same unit circle in three dimensions.
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
  CHECK(cosine({1.0f, 2.0f, 3.0f}, {1.0f, 2.0f, 3.0f}) <= 1.0f);
  CHECK_EQ(cosine({2.0f, 4.0f, 6.0f}, {1.0f, 2.0f, 3.0f}), 1.0f);
  CHECK_EQ(cosine({1.0f, 0.0f}, {0.0f, 1.0f}), 0.0f);
  CHECK(std::abs(cosine(at(0.0), at(60.0)) - 0.5f) < 1e-5f);
}

TEST(mismatched_or_zero_norm_vectors_cosine_to_zero_and_never_divide) {
  CHECK_EQ(cosine({1.0f, 0.0f, 0.0f}, {1.0f, 0.0f}), 0.0f);
  CHECK_EQ(cosine({1.0f, 0.0f}, {}), 0.0f);
  CHECK_EQ(cosine({}, {}), 0.0f);
  CHECK_EQ(cosine({0.0f, 0.0f}, {1.0f, 0.0f}), 0.0f);
  CHECK_EQ(cosine({1.0f, 0.0f}, {0.0f, 0.0f}), 0.0f);
  CHECK_EQ(cosine({0.0f, 0.0f}, {0.0f, 0.0f}), 0.0f);
  CHECK_EQ(cosine({1.0f, 0.0f}, {-1.0f, 0.0f}), 0.0f);
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
  CHECK_FALSE(sharesAnchor("he was again today and i did not know what to say",
                           "she was like that again tonight and i just could not think"));
  CHECK_FALSE(sharesAnchor("i think about it all the time", "we know that they will do it again"));
  CHECK_FALSE(sharesAnchor("", "marta"));
  CHECK_FALSE(sharesAnchor("marta", ""));
  CHECK_FALSE(sharesAnchor("...", "!!!"));
}

TEST(overlapping_only_on_common_words_is_not_an_anchor_even_when_both_have_content) {
  CHECK_FALSE(sharesAnchor("the kitchen was cold this morning",
                           "the office was loud this morning"));
}

TEST(a_shared_number_is_an_anchor) {
  CHECK(sharesAnchor("i turned 30 last week", "30 of them came"));
  CHECK_FALSE(sharesAnchor("i turned 30 last week", "31 of them came"));
}

TEST(the_owners_own_c_plus_plus_example_anchors) {
  CHECK(sharesAnchor("i want to learn c++.", "i like c++."));
}

TEST(a_capitalised_first_word_is_the_same_anchor_as_its_own_lower_case_form) {
  // Folding only 'A'-'Z' left sentence-initial Cyrillic a token no lower-case form could match, so
  // the first word of every Russian sentence was dead as an anchor.
  CHECK(sharesAnchor("Устал от всего", "устал опять"));
  CHECK(sharesAnchor("устал от всего", "Устал опять"));
  CHECK(sharesAnchor("ЁЛКА стоит", "ёлка упала"));         // Ё folds outside the А-Я block
  CHECK(sharesAnchor("Ünnepel", "ünnepel"));               // and Latin-1 folds too
  CHECK_FALSE(sharesAnchor("Устал от всего", "выспался наконец"));
}

TEST(non_ascii_punctuation_is_a_boundary_and_never_part_of_the_word_beside_it) {
  // Every mark here is >= 0x80, so a byte-wise rule glued it into the token beside it: «Работа» was
  // one word and never matched работа.
  CHECK(sharesAnchor("«Работа» съела вечер", "работа опять до ночи"));
  CHECK(sharesAnchor("сербия… наконец", "сербия рядом"));
  CHECK(sharesAnchor("марта" "\xC2\xA0" "пришла", "пришла марта"));   // no-break space
  CHECK(sharesAnchor("это" "\xE2\x80\x99" "марта", "марта"));         // curly apostrophe

  // And an em dash is not a word two passages can have in common.
  CHECK_FALSE(sharesAnchor("тишина — и всё", "молчание — снова"));
  CHECK_FALSE(sharesAnchor("…", "…"));
  CHECK_FALSE(sharesAnchor("— — —", "«»"));
}

TEST(a_script_the_classifier_does_not_know_yields_no_anchors_rather_than_punctuation) {
  CHECK_FALSE(sharesAnchor("今日はつかれた", "今日はつかれた"));
  CHECK_FALSE(sharesAnchor("🙂🙂", "🙂"));
  CHECK_FALSE(sharesAnchor("\xFF\xFE marta", "\xFF\xFE anna"));   // and a malformed byte ends a token
  CHECK(sharesAnchor("\xFF\xFE marta", "marta again"));
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

  // The trigger's own row is in the corpus, as when a caller hands over the whole journal.
  std::vector<Vectored> corpus{trigger};
  for (int i = 0; i < 4; ++i) corpus.push_back(span(100 + i, "2026-01-01", at(10.0)));

  CHECK_FALSE(isRefrain(trigger, corpus, rules));
}

namespace {

// `near` passages inside refrainRadius of a trigger at at(0.0) — cosine 0.985 — and the rest far
// outside it, at 0.174.
std::vector<Vectored> crowdedCorpus(int total, int near) {
  std::vector<Vectored> corpus;
  for (int i = 0; i < total; ++i)
    corpus.push_back(span(100 + i, "2026-01-01", i < near ? at(10.0) : at(80.0)));
  return corpus;
}

}

TEST(the_refrain_gate_is_a_share_of_the_history_over_an_absolute_floor) {
  const SelectionRules rules;   // refrainCrowd 5, refrainShare 0.05
  CHECK_EQ(refrainThreshold(0, rules), 5);
  CHECK_EQ(refrainThreshold(20, rules), 5);     // the floor, not one
  CHECK_EQ(refrainThreshold(100, rules), 5);    // where the share catches the floor up
  CHECK_EQ(refrainThreshold(200, rules), 10);
  CHECK_EQ(refrainThreshold(600, rules), 30);

  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);

  // 6% of a 200-passage history is a refrain...
  CHECK(isRefrain(trigger, crowdedCorpus(200, 12), rules));
  CHECK_FALSE(isRefrain(trigger, crowdedCorpus(200, 9), rules));
  // ...and the same 6% of a 20-passage history is not: under the floor the absolute count rules.
  CHECK_FALSE(isRefrain(trigger, crowdedCorpus(20, 1), rules));
  CHECK(isRefrain(trigger, crowdedCorpus(20, 5), rules));
}

TEST(a_constant_handful_of_neighbours_never_turns_into_a_refrain_as_the_history_grows) {
  // The time bomb, asserted directly: with a fixed count for a gate, the crowd a tail fraction puts
  // around a trigger grows with the corpus and silences whoever journals most. A trigger whose own
  // neighbourhood does not grow must read the same at 20 passages and at 200.
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);
  for (const int total : {20, 50, 100, 200, 600}) {
    CHECK_EQ(crowdOf(trigger, crowdedCorpus(total, 4), SelectionRules{}), 4);
    CHECK_FALSE(isRefrain(trigger, crowdedCorpus(total, 4), SelectionRules{}));
  }
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

  // One candidate on each side of every band edge, all at the same cosine.
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

TEST(the_same_sentence_typed_twice_is_a_restatement_wherever_the_embedder_put_it) {
  // Orthogonal vectors: cosine 0 to the trigger, so only the exact identity test can catch it. The
  // whitespace differs, which normalizedForIdentity is exactly what collapses.
  const Vectored trigger =
      Vectored{1, LocalDate{kToday}, "  i want to learn rust\n with marta ", axis(4, 0)};
  const std::vector<Vectored> candidates{
      span(10, "2026-01-01", axis(4, 1), "i want to learn rust with marta"),
      span(11, "2025-06-01", {0.6f, 0.0f, 0.8f, 0.0f}, kAnchoredText)};
  CHECK_EQ(cosine(trigger.vector, candidates[0].vector), 0.0f);

  const Selection selection = selectExplained(trigger, candidates, SelectionRules{});

  CHECK_EQ(matchIds(selection.pairings), (std::vector<std::int64_t>{11}));
  REQUIRE_EQ(selection.notes.size(), std::size_t{2});
  CHECK_EQ(std::string{fateText(selection.notes[0].fate)}, std::string{"restatement"});
  CHECK_EQ(std::string{fateText(selection.notes[1].fate)}, std::string{"selected"});
}

TEST(a_candidate_sharing_no_anchor_with_the_trigger_is_dropped_however_close_it_sits) {
  const Vectored trigger = span(1, kToday, at(0.0), kTriggerText);   // anchors: learn, rust, marta
  const std::vector<Vectored> candidates{
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

  // Every pair is within 3.6 degrees of every other, inside familyRadius 0.85; the OLDEST is the FURTHEST from the trigger.
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
  // Seven mutually orthogonal candidates, cosine falling off in span-id order; the four closest are inside the last month.
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
  CHECK(cosine(inPlane(25.0), inPlane(62.0)) < SelectionRules{}.familyRadius);

  const std::vector<Pairing> pairings = select(trigger, candidates, SelectionRules{});

  CHECK_EQ(matchIds(pairings), (std::vector<std::int64_t>{11, 13, 12}));
  CHECK(pairings[1].score > pairings[2].score);
}

TEST(a_representative_standing_for_eight_near_copies_is_outranked_by_a_lone_passage) {
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, {1.0f, 0.0f, 0.0f}};

  // Eight candidates across ten degrees — one family (widest pair cosines 0.985) — plus one lifted out of their plane.
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

  CHECK_EQ(matchIds(select(trigger, candidates, roomForThree)),
           (std::vector<std::int64_t>{11, 12, 13}));

  CHECK_EQ(matchIds(select(trigger, candidates, roomForTwo)), (std::vector<std::int64_t>{11, 13}));
}

TEST(identical_inputs_yield_identical_pairings_down_to_the_tie_break) {
  // All three cosines are exactly 0.5: stddev zero, the z guard fires, every z is 0. The input is deliberately out of order.
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

  CHECK_EQ(matchIds(pairings), (std::vector<std::int64_t>{100, 999}));
  CHECK_EQ(pairings[0].familySize, 14);
  CHECK_EQ(pairings[1].familySize, 1);
  CHECK(std::abs(pairings[1].cosine - 0.72f) < 1e-3f);
}

namespace {

// "no note" rather than a crash when the span is absent.
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
  // Two triggers, each with exactly one candidate it can anchor to: candidate 10 shares "rust" with the first, candidate 11 with the second.
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

  const PageSelection capped = selectForPage({first, second}, history, {}, SelectionRules{}, 1);
  CHECK_EQ(capped.pairings.size(), std::size_t{1});
  CHECK_EQ(capped.cappedOut, 1);
  const bool firstKept = capped.pairings[0].triggerSpanId == 1;
  CHECK_EQ(fateOf(capped.traces[firstKept ? 1 : 0], firstKept ? 11 : 10), std::string{"page_cap"});

  const PageSelection waved =
      selectForPage({first, second}, history, {{1, 10}}, SelectionRules{}, 10);
  CHECK_EQ(waved.pairings.size(), std::size_t{1});
  CHECK_EQ(waved.pairings[0].triggerSpanId, std::int64_t{2});
  CHECK_EQ(fateOf(waved.traces[0], 10), std::string{"dismissed"});
}

TEST(two_pairings_into_one_past_day_collapse_to_the_best_scoring_card) {
  // The reader's surface and the write side are both day-grained, so two pairings reaching into one
  // past page would be two cards sharing one dismissal row.
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, axis(4, 0)};
  const std::vector<Vectored> history{
      span(10, "2025-06-01", {0.9f, 0.436f, 0.0f, 0.0f}, kAnchoredText),
      span(11, "2025-06-01", {0.7f, 0.0f, 0.714f, 0.0f}, "rust, and the compiler again"),
      span(12, "2025-03-05", {0.6f, 0.0f, 0.0f, 0.8f}, kAnchoredText)};
  // Not one family, and none of them a restatement: the collapse is the day, not the distance.
  CHECK(cosine(history[0].vector, history[1].vector) < SelectionRules{}.familyRadius);
  CHECK(cosine(trigger.vector, history[0].vector) < SelectionRules{}.restatement);

  const PageSelection page = selectForPage({trigger}, history, {}, SelectionRules{}, 10);

  CHECK_EQ(matchIds(page.pairings), (std::vector<std::int64_t>{10, 12}));
  CHECK_EQ(fateOf(page.traces[0], 10), std::string{"selected"});
  CHECK_EQ(fateOf(page.traces[0], 11), std::string{"same_day"});
  CHECK_EQ(fateOf(page.traces[0], 12), std::string{"selected"});
  CHECK_EQ(page.cappedOut, 0);

  // The cap counts CARDS: it is applied after the collapse, so the loser of a day never spends a
  // slot the reader would have seen used by another day.
  const PageSelection capped = selectForPage({trigger}, history, {}, SelectionRules{}, 2);
  CHECK_EQ(matchIds(capped.pairings), (std::vector<std::int64_t>{10, 12}));
  CHECK_EQ(capped.cappedOut, 0);

  // And the knob is a knob: two cards from one day when the surface is told it can hold two.
  SelectionRules twoPerDay;
  twoPerDay.maxPerMatchDay = 2;
  const PageSelection both = selectForPage({trigger}, history, {}, twoPerDay, 10);
  CHECK_EQ(matchIds(both.pairings), (std::vector<std::int64_t>{10, 11, 12}));
  CHECK_EQ(fateOf(both.traces[0], 11), std::string{"selected"});
}

TEST(near_misses_are_reported_only_when_asked_for) {
  const Vectored trigger = Vectored{1, LocalDate{kToday}, kTriggerText, axis(4, 0)};
  // Two days old — inside minDayGap, so retrieval never hands it over.
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

namespace {

// Twelve passages of one writer's ordinary vocabulary: "не" is common, "сербию" rare.
std::vector<Vectored> russianCorpus() {
  const std::string lines[] = {
      "сегодня мигрень, болит голова, парацетомол не помог",
      "сходил к челу спинному, он сказал что спина в порядке, ниче не надо",
      "на работе запара, не успеваю ничего",
      "не знаю что делать с этим проектом",
      "вечером все кайф, прогулка помогла",
      "вечером чувствую себя отдохнувшим, эмбиент кайф",
      "кайф от того что не надо никуда идти",
      "кайф полный, выспался наконец",
      "хочется в сербию пить вино днями напролет",
      "хочется уже в сербию",
      "клод не делает красиво, надо много итераций",
      "не могу контролить юай, не умею",
  };
  std::vector<Vectored> corpus;
  for (std::size_t i = 0; i < std::size(lines); ++i)
    corpus.push_back(span(static_cast<std::int64_t>(200 + i), "2026-06-0" + std::to_string(i % 9 + 1),
                          axis(4, i % 4), lines[i]));
  return corpus;
}

}

TEST(a_word_the_writer_uses_constantly_is_not_an_anchor_in_any_language) {
  const AnchorVocabulary vocabulary = AnchorVocabulary::of(russianCorpus(), SelectionRules{});

  // "не" is in 7 of 12 passages.
  CHECK_EQ(vocabulary.common.count("не") > 0, true);
  // "сербию" is in 2 of 12.
  CHECK_EQ(vocabulary.common.count("сербию") > 0, false);

  CHECK_EQ(sharesAnchor("сегодня мигрень, болит голова на 3/10, парацетомол не помогли",
                        "сходил к челу спинному, он сказал что спина в порядке, ниче не надо",
                        vocabulary),
           false);
  CHECK_EQ(sharesAnchor("хочется уже в сербию",
                        "честно говоря хочется в сербию пить вино днями напролет", vocabulary),
           true);
}

TEST(the_writers_own_common_word_is_stoplisted_however_the_sentence_capitalised_it) {
  // The document-frequency rule counts folded words, so a word the writer opens sentences with is
  // ONE word: four passages of "кайф", not two of "Кайф" and two of "кайф", neither of which would
  // have reached the threshold of three.
  const std::string lines[] = {
      "Кайф полный, выспался наконец",
      "кайф от того что не надо никуда идти",
      "Кайф, прогулка помогла",
      "вечером все кайф, эмбиент",
      "хочется в сербию пить вино днями напролет",
      "Хочется уже в сербию",
      "на работе запара, не успеваю ничего",
      "Работа не отпускает даже вечером",
      "клод не делает красиво, надо много итераций",
      "не могу контролить юай, не умею",
      "сегодня мигрень, болит голова",
      "сходил к челу спинному, спина в порядке",
  };
  std::vector<Vectored> corpus;
  for (std::size_t i = 0; i < std::size(lines); ++i)
    corpus.push_back(span(static_cast<std::int64_t>(300 + i),
                          "2026-06-0" + std::to_string(i % 9 + 1), axis(4, i % 4), lines[i]));

  const AnchorVocabulary vocabulary = AnchorVocabulary::of(corpus, SelectionRules{});

  CHECK_EQ(vocabulary.common.count("кайф") > 0, true);      // 4 of 12, capital and lower one word
  CHECK_EQ(vocabulary.common.count("Кайф") > 0, false);     // the vocabulary holds folded words only
  CHECK_EQ(vocabulary.common.count("хочется") > 0, false);  // 2 of 12
  CHECK_EQ(vocabulary.common.count("работа") > 0, false);   // 1 of 12: no stemmer joins it to работе

  CHECK_EQ(sharesAnchor("Кайф какой-то", "кайф весь вечер", vocabulary), false);
  CHECK_EQ(sharesAnchor("Кайф какой-то", "кайф весь вечер"), true);   // the English list alone lets it through
  CHECK_EQ(sharesAnchor("Хочется уже в сербию", "хочется в сербию снова", vocabulary), true);
}

TEST(a_corpus_too_small_to_know_what_is_common_says_nothing_is) {
  std::vector<Vectored> few = russianCorpus();
  // Under vocabularyFloor. erase, not resize: Vectored holds a LocalDate and has no default ctor.
  few.erase(few.begin() + 4, few.end());

  const AnchorVocabulary vocabulary = AnchorVocabulary::of(few, SelectionRules{});
  CHECK_EQ(vocabulary.common.empty(), true);
  CHECK_EQ(sharesAnchor("i want to learn rust", "the rust compiler again", vocabulary), true);
  CHECK_EQ(sharesAnchor("i want to learn rust", "i want to get the thing", vocabulary), false);
}
