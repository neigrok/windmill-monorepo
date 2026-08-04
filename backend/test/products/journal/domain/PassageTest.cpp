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

// Every field of every passage in one comparable line — "ord:lo-hi:text" — so a case can pin the
// whole result including the byte offsets, not a sample of it.
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

// The three promises the contract makes about every passage it returns, asserted for all of them at
// once: the span indexes back into the body exactly, both ends land on a codepoint boundary, and
// the ordinals are 0-based and contiguous.
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

TEST(a_line_break_ends_a_passage_even_when_the_sentence_cap_has_room) {
  // Two sentences, thirteen words, well inside a three-sentence passage — and still two passages,
  // because the line between them is a wall.
  const std::string body =
      "i finally called mum about the house today.\nhe texted me again about the weekend.";

  const std::vector<Passage> passages = segment(body);

  CHECK_EQ(textsOf(passages), (Texts{"i finally called mum about the house today.",
                                     "he texted me again about the weekend."}));
  checkContract(body, passages);
}

TEST(prose_on_one_line_splits_at_the_sentence_cap) {
  const std::string body =
      "i finally called mum about the house today. she sounded better than she did last week. "
      "i skipped the run again this evening. he texted me again about the weekend.";

  const std::vector<Passage> passages = segment(body);

  CHECK_EQ(textsOf(passages),
           (Texts{"i finally called mum about the house today. she sounded better than she did last "
                  "week. i skipped the run again this evening.",
                  "he texted me again about the weekend."}));
  checkContract(body, passages);

  // The cap is a rule, not a constant: one sentence per passage puts all four back on the table.
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

  // Spelled out once rather than left to the helper: this is the guarantee the whole pipeline
  // stands on, and it is a byte comparison against the body itself.
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
  // Same three sentences, the fragment moved to the front: with nothing before it, it glues forward.
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

  // One sentence per passage, so the only thing holding these lines together is the refusal — and
  // an ordinary full stop still splits.
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

TEST(fragments_merge_even_where_that_overruns_the_sentence_cap) {
  // Four sentences and four words. Splitting this at three sentences would buy a cap and pay in
  // fragments, which are the thing the cap exists to avoid.
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

  // The passage is the fragment, not the padding around it.
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
  // The one thing this function is for: the same sentence, rewrapped by the editor, is the same
  // passage — and a different sentence is not.
  CHECK_EQ(normalizedForIdentity("i finally called mum\nabout the house today."),
           normalizedForIdentity("i finally called mum about the house today."));
  CHECK(normalizedForIdentity("i finally called mum about the house today.") !=
        normalizedForIdentity("i finally called mum about the house."));
}
