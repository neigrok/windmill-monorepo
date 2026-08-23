#include "products/journal/domain/Passage.h"

#include "test/testing.h"

#include <cstddef>
#include <string>
#include <vector>

using namespace wm;

namespace {

using Texts = std::vector<std::string>;

Texts textsOf(const std::vector<Passage>& passages) {
  Texts texts;
  for (const Passage& passage : passages) texts.push_back(passage.text);
  return texts;
}

// Every field of every passage in one comparable line — "ord:lo-hi:text".
Texts shapeOf(const std::vector<Passage>& passages) {
  Texts shapes;
  for (const Passage& passage : passages) {
    shapes.push_back(std::to_string(passage.ord) + ":" + std::to_string(passage.lo) + "-" +
                     std::to_string(passage.hi) + ":" + passage.text);
  }
  return shapes;
}

bool isCodepointStart(const std::string& body, int at) {
  if (at >= static_cast<int>(body.size())) return true;
  return (static_cast<unsigned char>(body[at]) & 0xC0) != 0x80;
}

// The three promises: the span indexes back into the body exactly, both ends land on a codepoint boundary, and the ordinals are 0-based and contiguous.
void checkContract(const std::string& body, const std::vector<Passage>& passages) {
  for (std::size_t i = 0; i < passages.size(); ++i) {
    const Passage& passage = passages[i];
    CHECK_EQ(passage.ord, static_cast<int>(i));
    CHECK(passage.lo >= 0);
    CHECK(passage.lo < passage.hi);
    CHECK(passage.hi <= static_cast<int>(body.size()));
    CHECK_EQ(body.substr(passage.lo, passage.hi - passage.lo), passage.text);
    CHECK(isCodepointStart(body, passage.lo));
    CHECK(isCodepointStart(body, passage.hi));
  }
}

}

TEST(a_bare_list_with_no_terminal_punctuation_is_one_passage_per_line) {
  const std::string body = "- called mum\n- didnt run\n- he texted";

  const std::vector<Passage> passages = segment(body);

  CHECK_EQ(shapeOf(passages), (Texts{"0:0-12:- called mum", "1:13-24:- didnt run", "2:25-36:- he texted"}));
  checkContract(body, passages);
}

TEST(a_line_break_ends_a_passage_even_when_the_atom_cap_has_room) {
  const std::string body =
      "i finally called mum about the house today.\nhe texted me again about the weekend.";

  const std::vector<Passage> passages = segment(body);

  CHECK_EQ(textsOf(passages), (Texts{"i finally called mum about the house today.",
                                     "he texted me again about the weekend."}));
  checkContract(body, passages);
}

TEST(prose_on_one_line_splits_at_the_atom_cap) {
  const std::string body =
      "i finally called mum about the house today. she sounded better than she did last week. "
      "i skipped the run again this evening. he texted me again about the weekend.";

  const std::vector<Passage> passages = segment(body);

  CHECK_EQ(textsOf(passages),
           (Texts{"i finally called mum about the house today. she sounded better than she did last "
                  "week. i skipped the run again this evening.",
                  "he texted me again about the weekend."}));
  checkContract(body, passages);

  const std::vector<Passage> singles = segment(body, SegmentRules{1, 1});

  CHECK_EQ(textsOf(singles), (Texts{"i finally called mum about the house today.",
                                    "she sounded better than she did last week.",
                                    "i skipped the run again this evening.",
                                    "he texted me again about the weekend."}));
  checkContract(body, singles);
}

TEST(spans_index_back_into_a_body_of_emoji_and_accents) {
  const std::string body =
      "café ☕ closed early so i walked the long way home.\n"
      "j'étais fatigué 😀 mais content de marcher un peu\n"
      "- naïve idea: sleep before midnight";

  const std::vector<Passage> passages = segment(body);

  CHECK_EQ(textsOf(passages), (Texts{"café ☕ closed early so i walked the long way home.",
                                     "j'étais fatigué 😀 mais content de marcher un peu",
                                     "- naïve idea: sleep before midnight"}));
  checkContract(body, passages);

  CHECK_EQ(body.substr(passages[1].lo, passages[1].hi - passages[1].lo),
           std::string("j'étais fatigué 😀 mais content de marcher un peu"));
}

TEST(a_fragment_joins_the_passage_before_it) {
  const std::string body =
      "he texted me again about the weekend. tired. i went to bed early and slept badly.";

  const std::vector<Passage> passages = segment(body, SegmentRules{6, 2});

  CHECK_EQ(textsOf(passages), (Texts{"he texted me again about the weekend. tired.",
                                     "i went to bed early and slept badly."}));
  checkContract(body, passages);
}

TEST(a_fragment_that_opens_the_line_joins_the_passage_after_it) {
  const std::string body =
      "tired. he texted me again about the weekend. i went to bed early and slept badly.";

  const std::vector<Passage> passages = segment(body, SegmentRules{6, 2});

  CHECK_EQ(textsOf(passages), (Texts{"tired. he texted me again about the weekend.",
                                     "i went to bed early and slept badly."}));
  checkContract(body, passages);
}

TEST(a_fragment_never_merges_across_a_line_break) {
  const std::string body = "tired\ni finally called mum about the house today.";

  const std::vector<Passage> passages = segment(body);

  CHECK_EQ(textsOf(passages), (Texts{"tired", "i finally called mum about the house today."}));
  checkContract(body, passages);
}

TEST(a_numbered_list_keeps_its_marker_and_stays_one_passage_per_line) {
  const std::string body = "1. called mum about the house\n2. skipped the run again";

  const std::vector<Passage> passages = segment(body);

  CHECK_EQ(textsOf(passages), (Texts{"1. called mum about the house", "2. skipped the run again"}));
  checkContract(body, passages);
}

TEST(abbreviations_and_decimals_do_not_end_a_sentence) {
  const std::string body =
      "dr. nowak said the results were fine and i believed her.\n"
      "i ran 3.5 miles before work this morning.\n"
      "i bought bread, milk, etc. and then walked home.\n"
      "mr. and mrs. patel moved out on saturday morning.\n"
      "i left early, i.e. before the meeting ended, and walked home.";

  const std::vector<Passage> passages = segment(body, SegmentRules{1, 1});

  CHECK_EQ(textsOf(passages), (Texts{"dr. nowak said the results were fine and i believed her.",
                                     "i ran 3.5 miles before work this morning.",
                                     "i bought bread, milk, etc. and then walked home.",
                                     "mr. and mrs. patel moved out on saturday morning.",
                                     "i left early, i.e. before the meeting ended, and walked home."}));
  checkContract(body, passages);

  CHECK_EQ(textsOf(segment("dr. nowak said hello. i left.", SegmentRules{1, 1})),
           (Texts{"dr. nowak said hello.", "i left."}));
}

TEST(a_closing_quote_stays_with_the_sentence_it_closes) {
  const std::string body = "he said \"i'm done.\" i didnt argue with him about it.";

  const std::vector<Passage> passages = segment(body, SegmentRules{1, 1});

  CHECK_EQ(textsOf(passages),
           (Texts{"he said \"i'm done.\"", "i didnt argue with him about it."}));
  checkContract(body, passages);
}

TEST(fragments_merge_even_where_that_overruns_the_atom_cap) {
  const std::string body = "hi. ok. no. yes.";

  const std::vector<Passage> passages = segment(body);

  CHECK_EQ(shapeOf(passages), (Texts{"0:0-16:hi. ok. no. yes."}));
  checkContract(body, passages);
}

TEST(an_empty_or_whitespace_only_body_has_no_passages) {
  CHECK_EQ(textsOf(segment("")), Texts{});
  CHECK_EQ(textsOf(segment(" ")), Texts{});
  CHECK_EQ(textsOf(segment("   \n\t \n\r\n  ")), Texts{});
  CHECK_EQ(textsOf(segment("\n\n\n")), Texts{});
}

TEST(a_single_short_fragment_is_one_passage_and_never_none) {
  const std::string body = "tired";

  CHECK_EQ(shapeOf(segment(body)), Texts{"0:0-5:tired"});
  checkContract(body, segment(body));

  const std::string padded = "  tired  ";
  CHECK_EQ(shapeOf(segment(padded)), Texts{"0:2-7:tired"});
  checkContract(padded, segment(padded));
}

TEST(carriage_returns_and_a_trailing_newline_stay_out_of_the_spans) {
  const std::string body = "called mum\r\nskipped the run\r\n";

  const std::vector<Passage> passages = segment(body);

  CHECK_EQ(shapeOf(passages), (Texts{"0:0-10:called mum", "1:12-27:skipped the run"}));
  checkContract(body, passages);
}

TEST(the_same_body_always_segments_the_same_way) {
  const std::string body =
      "café ☕ closed early. dr. nowak said the results were fine and i believed her. tired.\n"
      "- called mum\n"
      "\n"
      "i ran 3.5 miles before work this morning and it felt easier than last week. he texted.";

  CHECK_EQ(shapeOf(segment(body)), shapeOf(segment(body)));
  CHECK_EQ(shapeOf(segment(body, SegmentRules{4, 2})), shapeOf(segment(body, SegmentRules{4, 2})));
  checkContract(body, segment(body));
}

TEST(normalized_identity_trims_and_collapses_whitespace_and_nothing_else) {
  CHECK_EQ(normalizedForIdentity("  i  went\tto\r\nthe   shop  "), std::string("i went to the shop"));
  CHECK_EQ(normalizedForIdentity("i went to the shop"), std::string("i went to the shop"));
  CHECK_EQ(normalizedForIdentity(""), std::string(""));
  CHECK_EQ(normalizedForIdentity("     "), std::string(""));
  CHECK_EQ(normalizedForIdentity("café  ☕  😀"), std::string("café ☕ 😀"));
}

TEST(normalized_identity_does_not_fold_case_or_strip_punctuation) {
  CHECK_EQ(normalizedForIdentity("Tired Again"), std::string("Tired Again"));
  CHECK_EQ(normalizedForIdentity("no, i didn't."), std::string("no, i didn't."));
  CHECK(normalizedForIdentity("tired") != normalizedForIdentity("Tired"));
  CHECK(normalizedForIdentity("i quit.") != normalizedForIdentity("i quit"));
}

TEST(normalized_identity_makes_a_passage_survive_a_reflow) {
  CHECK_EQ(normalizedForIdentity("i finally called mum\nabout the house today."),
           normalizedForIdentity("i finally called mum about the house today."));
  CHECK(normalizedForIdentity("i finally called mum about the house today.") !=
        normalizedForIdentity("i finally called mum about the house."));
}

// The verbatim check: a unit is kept only if it is genuinely in the body, and what is stored is the BODY's bytes rather than the model's.

TEST(units_are_kept_only_where_they_are_genuinely_in_the_body) {
  const std::string body = "заебался, нет сил продолжать\nзато завтра выходной";
  const std::vector<Passage> located =
      locateUnits(body, {"заебался, нет сил продолжать", "зато завтра выходной"});

  REQUIRE_EQ(located.size(), std::size_t{2});
  CHECK_EQ(located[0].text, std::string{"заебался, нет сил продолжать"});
  CHECK_EQ(located[1].text, std::string{"зато завтра выходной"});
  CHECK_EQ(body.substr(located[0].lo, located[0].hi - located[0].lo), located[0].text);
  CHECK_EQ(body.substr(located[1].lo, located[1].hi - located[1].lo), located[1].text);
  CHECK_EQ(located[0].ord, 0);
  CHECK_EQ(located[1].ord, 1);
}

TEST(a_unit_the_model_rewrote_is_discarded_rather_than_shown_to_the_writer) {
  const std::string body = "заебался, нет сил продолжать. пиздец как тяжело";
  const std::vector<Passage> located = locateUnits(body, {
      "устал, нет сил продолжать",
      "Заебался, нет сил продолжать",
      "i am exhausted",
      "пиздец как тяжело",
  });

  REQUIRE_EQ(located.size(), std::size_t{1});
  CHECK_EQ(located[0].text, std::string{"пиздец как тяжело"});
}

TEST(a_unit_spanning_a_soft_line_break_still_locates) {
  // "One unit per line" flattens the newline the writer typed into a space; that is the one difference tolerated.
  const std::string body = "хочу переехать в лиссабон,\nно тогда я всех оставлю здесь";
  const std::vector<Passage> located =
      locateUnits(body, {"хочу переехать в лиссабон, но тогда я всех оставлю здесь"});

  REQUIRE_EQ(located.size(), std::size_t{1});
  CHECK_EQ(located[0].text, body);
  CHECK_EQ(located[0].lo, 0);
  CHECK_EQ(located[0].hi, static_cast<int>(body.size()));
}

TEST(the_same_sentence_twice_takes_two_different_places) {
  const std::string body = "не знаю. надо подумать. не знаю.";
  const std::vector<Passage> located = locateUnits(body, {"не знаю.", "надо подумать.", "не знаю."});

  REQUIRE_EQ(located.size(), std::size_t{3});
  // The scan runs forward, so the second "не знаю." anchors to the SECOND occurrence.
  CHECK_EQ(located[0].lo, 0);
  CHECK_EQ(located[2].lo, static_cast<int>(body.rfind("не знаю.")));
  CHECK(located[1].lo > located[0].lo);
}

TEST(units_returned_out_of_order_are_still_found) {
  const std::string body = "первое. второе. третье.";
  const std::vector<Passage> located = locateUnits(body, {"третье.", "первое."});

  // Found from the top on the second pass rather than dropped: a segmenter that reordered its answer still named real text.
  REQUIRE_EQ(located.size(), std::size_t{2});
  CHECK_EQ(located[0].text, std::string{"третье."});
  CHECK_EQ(located[1].text, std::string{"первое."});
}

// ATOMS AND GROUPING. A segmenter answers in NUMBERS: which ATOM each idea unit starts at. The
// model never receives a place to put text, so a misquote stops being a thing to detect and becomes
// a thing that cannot happen.

TEST(atoms_cut_to_the_floor_and_units_are_runs_of_them) {
  const std::string body = "заебался. еще и заболел.\nхочется в сербию. но это ничего не решит.";
  const std::vector<Passage> atoms = atomsOf(body);
  REQUIRE_EQ(atoms.size(), std::size_t{4});
  CHECK_EQ(atoms[0].text, std::string{"заебался."});
  CHECK_EQ(atoms[3].text, std::string{"но это ничего не решит."});

  // Three thoughts: the wish and its objection are one unit, which is the product requirement.
  const Grouping grouped = unitsFrom(body, atoms, {1, 2, 3});
  CHECK_EQ(grouped.dropped, 0);
  REQUIRE_EQ(grouped.units.size(), std::size_t{3});
  CHECK_EQ(grouped.units[2].text, std::string{"хочется в сербию. но это ничего не решит."});
  for (const Passage& unit : grouped.units)
    CHECK_EQ(body.substr(unit.lo, unit.hi - unit.lo), unit.text);
}

TEST(a_broken_answer_is_repaired_and_the_units_still_tile_the_page) {
  const std::string body = "one. two. three.";
  const std::vector<Passage> atoms = atomsOf(body);
  REQUIRE_EQ(atoms.size(), std::size_t{3});

  // Out of range, out of order, duplicated, and missing the opening 1.
  const Grouping grouped = unitsFrom(body, atoms, {9, 3, 3, 0});
  CHECK_EQ(grouped.dropped, 3);
  REQUIRE_EQ(grouped.units.size(), std::size_t{2});
  CHECK_EQ(grouped.units[0].text, std::string{"one. two."});
  CHECK_EQ(grouped.units[1].text, std::string{"three."});
}

TEST(an_answer_naming_nothing_usable_still_yields_the_whole_page) {
  const std::string body = "one. two.";
  const std::vector<Passage> atoms = atomsOf(body);

  const Grouping grouped = unitsFrom(body, atoms, {});
  REQUIRE_EQ(grouped.units.size(), std::size_t{1});
  CHECK_EQ(grouped.units[0].text, body);
  CHECK_EQ(grouped.dropped, 0);
}

TEST(a_page_with_no_atoms_groups_into_nothing) {
  CHECK_EQ(atomsOf("   \n\t ").empty(), true);
  CHECK_EQ(unitsFrom("   \n\t ", {}, {1, 2}).units.empty(), true);
}

// THE ATOM GRAMMAR. Every case below was ONE atom under the sentence-only grid that shipped first,
// which made it one embedding carrying every thought on the line — and, at one atom, a page the
// segmenter was never even shown.

TEST(a_comma_spliced_line_of_three_topics_is_not_left_as_one_atom) {
  const std::string body =
      "сегодня опять заебался на работе и ничего не успел, потом еще с мамой поругался "
      "из-за квартиры, а вечером снова не пошел на тренировку и просто лежал и смотрел в потолок";

  const std::vector<Passage> atoms = atomsOf(body);

  CHECK_EQ(textsOf(atoms),
           (Texts{"сегодня опять заебался на работе и ничего не успел,",
                  "потом еще с мамой поругался из-за квартиры,",
                  "а вечером снова не пошел на тренировку и просто лежал и смотрел в потолок"}));
  checkContract(body, atoms);
}

TEST(a_dash_between_clauses_opens_an_atom) {
  const std::string body = "хочется все бросить и уехать в сербию — но это ничего не решит";

  const std::vector<Passage> atoms = atomsOf(body);

  CHECK_EQ(textsOf(atoms),
           (Texts{"хочется все бросить и уехать в сербию", "— но это ничего не решит"}));
  checkContract(body, atoms);
}

TEST(an_ellipsis_and_a_semicolon_end_an_atom) {
  const std::string body = "не знаю что делать дальше… надо просто поспать; завтра будет видно";

  const std::vector<Passage> atoms = atomsOf(body);

  CHECK_EQ(textsOf(atoms), (Texts{"не знаю что делать дальше…", "надо просто поспать;",
                                  "завтра будет видно"}));
  checkContract(body, atoms);

  // The typed-out ellipsis is the same boundary, and the three dots are one of them, not three.
  CHECK_EQ(textsOf(atomsOf("не знаю... надо поспать")), (Texts{"не знаю...", "надо поспать"}));
  CHECK_EQ(textsOf(atomsOf("план на завтра: встать в семь")),
           (Texts{"план на завтра:", "встать в семь"}));
}

TEST(a_mid_line_list_marker_opens_an_atom) {
  const std::string body = "+я буду делать зарядку каждое утро + машу рукой всем кто не верит";

  const std::vector<Passage> atoms = atomsOf(body);

  CHECK_EQ(textsOf(atoms),
           (Texts{"+я буду делать зарядку каждое утро", "+ машу рукой всем кто не верит"}));
  checkContract(body, atoms);
}

TEST(a_diary_is_not_a_calculator_and_pays_for_it_in_the_cheap_direction) {
  const std::string body = "было 3 - 2 в нашу пользу\nна улице -5 градусов и какой-то мокрый снег";

  const std::vector<Passage> atoms = atomsOf(body);

  // The arithmetic is cut, because the rule that finds a list cannot tell one from the other. A
  // digit right after the marker is left alone, and a hyphen inside a word is never a marker.
  CHECK_EQ(textsOf(atoms), (Texts{"было 3", "- 2 в нашу пользу",
                                  "на улице -5 градусов и какой-то мокрый снег"}));
  checkContract(body, atoms);
}

TEST(a_long_line_splits_at_commas_that_leave_three_words_on_each_side) {
  const std::string body =
      "нет, я правда не понимаю зачем я каждый раз соглашаюсь на это, "
      "когда мне совсем не хочется, и потом лежу и жалею об этом весь вечер, да";

  const std::vector<Passage> atoms = atomsOf(body);

  // The opening "нет," and the trailing "да" have fewer than three words on their side, so those
  // two commas are not boundaries; the two in the middle are.
  CHECK_EQ(textsOf(atoms),
           (Texts{"нет, я правда не понимаю зачем я каждый раз соглашаюсь на это,",
                  "когда мне совсем не хочется,", "и потом лежу и жалею об этом весь вечер, да"}));
  checkContract(body, atoms);
}

TEST(a_short_line_is_never_cut_at_its_commas) {
  // The same shape under `kLongAtomWords`: a comma is the last resort, not a boundary.
  const std::string body = "заебался, нет сил продолжать";

  CHECK_EQ(textsOf(atomsOf(body)), (Texts{"заебался, нет сил продолжать"}));
  CHECK_EQ(wordsIn(body), 4);
}

TEST(a_short_one_sentence_page_is_exactly_one_atom) {
  CHECK_EQ(textsOf(atomsOf("хочется уже в сербию")), (Texts{"хочется уже в сербию"}));
  CHECK_EQ(textsOf(atomsOf("tired")), (Texts{"tired"}));
  CHECK_EQ(textsOf(atomsOf("i finally called mum about the house today.")),
           (Texts{"i finally called mum about the house today."}));
}

TEST(a_finer_grid_costs_the_rule_path_nothing_because_merging_is_free) {
  const std::string body =
      "заебался; надо поспать\n"
      "+я буду вставать в семь + машу рукой тем кто не верит\n"
      "хочется уехать — но это ничего не решит… наверное";

  // Seven atoms, and the merge rules put every one of them back on the line it came from.
  REQUIRE_EQ(atomsOf(body).size(), std::size_t{7});
  CHECK_EQ(textsOf(segment(body)),
           (Texts{"заебался; надо поспать", "+я буду вставать в семь + машу рукой тем кто не верит",
                  "хочется уехать — но это ничего не решит… наверное"}));
  checkContract(body, segment(body));
}

TEST(units_still_tile_the_page_when_the_grid_is_this_fine) {
  const std::string body =
      "заебался; надо поспать\n"
      "+я буду вставать в семь + машу рукой тем кто не верит\n"
      "хочется уехать — но это ничего не решит… наверное";
  const std::vector<Passage> atoms = atomsOf(body);
  REQUIRE_EQ(atoms.size(), std::size_t{7});

  const Grouping grouped = unitsFrom(body, atoms, {1, 3, 6});

  CHECK_EQ(grouped.dropped, 0);
  CHECK_EQ(textsOf(grouped.units),
           (Texts{"заебался; надо поспать",
                  "+я буду вставать в семь + машу рукой тем кто не верит\nхочется уехать",
                  "— но это ничего не решит… наверное"}));
  checkContract(body, grouped.units);
  // Tiling: the first unit opens on the first atom, the last closes on the last, and no unit
  // overlaps its neighbour.
  CHECK_EQ(grouped.units.front().lo, atoms.front().lo);
  CHECK_EQ(grouped.units.back().hi, atoms.back().hi);
  for (std::size_t i = 1; i < grouped.units.size(); ++i)
    CHECK(grouped.units[i - 1].hi < grouped.units[i].lo);
}

TEST(words_are_counted_in_whitespace_separated_runs) {
  CHECK_EQ(wordsIn("- called mum"), 3);
  CHECK_EQ(wordsIn("  tired  "), 1);
  CHECK_EQ(wordsIn(""), 0);
  CHECK_EQ(wordsIn("   \n\t "), 0);
  CHECK_EQ(wordsIn("хочется все бросить и уехать в сербию"), 7);
}

// A unit is a run of atoms, so nothing in the grouping bounds its LENGTH — the model can answer
// starts=[1] on a page of any size. Past the embedder's window the sidecar REFUSES the batch (it
// will not silently truncate), the page fails, stays owed, and is cut by a vendor and refused again
// every six hours forever. So the bound is here, where it is free.
TEST(a_unit_too_heavy_for_the_embedder_is_split_on_its_own_atom_boundaries) {
  std::string body = "мысль номер 0 про то как я сегодня опять сидел и делал бэкенд.";
  for (int i = 1; i < 12; ++i)
    body += " мысль номер " + std::to_string(i) + " про то как я сегодня опять сидел и делал бэкенд.";
  const std::vector<Passage> atoms = atomsOf(body);
  REQUIRE(atoms.size() >= std::size_t{12});
  CHECK(wordsIn(body) > kMaxUnitWords);

  // The model asks for ONE unit covering the whole page, which is exactly the answer that would
  // produce a passage the sidecar cannot read.
  const Grouping grouped = unitsFrom(body, atoms, {1});

  CHECK(grouped.units.size() > std::size_t{1});
  for (const Passage& unit : grouped.units) {
    CHECK(wordsIn(unit.text) <= kMaxUnitWords);
    CHECK_EQ(body.substr(unit.lo, unit.hi - unit.lo), unit.text);
  }
  // Still a tiling: the first starts at the top and the last ends at the bottom, in order.
  CHECK_EQ(grouped.units.front().lo, 0);
  CHECK_EQ(grouped.units.back().hi, static_cast<int>(body.size()));
  for (std::size_t i = 1; i < grouped.units.size(); ++i)
    CHECK_EQ(grouped.units[i].lo, grouped.units[i - 1].hi + 1);
}

TEST(a_page_that_fits_is_not_split_by_the_weight_bound) {
  const std::string body = "коротко. и еще одна мысль. и третья.";
  const Grouping grouped = unitsFrom(body, atomsOf(body), {1});
  REQUIRE_EQ(grouped.units.size(), std::size_t{1});
  CHECK_EQ(grouped.units[0].text, body);
}

// The grammar's last resort. Every other cut is a seam somebody wrote; a line with no terminator, no
// dash, no marker and no comma offers none, and `unitsFrom` will not cut inside an atom — so without
// this the page would carry a unit of any length, and past the embedder's window the sidecar refuses
// the batch and the page can never be stored at all.
TEST(a_run_on_with_no_seam_at_all_is_still_cut_into_embeddable_atoms) {
  std::string body = "мысль";
  for (int i = 0; i < 200; ++i) body += " и еще одна мысль про то же самое";
  REQUIRE(body.find_first_of(".,!?;:") == std::string::npos);

  const std::vector<Passage> atoms = atomsOf(body);
  CHECK(atoms.size() > std::size_t{1});
  for (const Passage& atom : atoms) CHECK(wordsIn(atom.text) <= kMaxUnitWords);

  // And the units built from them stay inside the window whatever the model answers.
  const Grouping grouped = unitsFrom(body, atoms, {1});
  for (const Passage& unit : grouped.units) CHECK(wordsIn(unit.text) <= kMaxUnitWords);
  CHECK_EQ(grouped.units.front().lo, 0);
  CHECK_EQ(grouped.units.back().hi, static_cast<int>(body.size()));
}
