#include "platform/domain/sync/TextMerge.h"

#include "platform/domain/sync/Wire.h"

#include "test/testing.h"

#include <optional>
#include <string>
#include <vector>

using namespace wm::sync;

// §6.11 is pinned vector by vector in sync_corpus/text/*; these cases read the merge end to end.

namespace {

std::string scriptText(const std::vector<Edit>& script) {
  std::string text;
  for (const Edit& edit : script) {
    const char op = edit.op == EditOp::keep ? '=' : edit.op == EditOp::remove ? '-' : '+';
    text += std::string(text.empty() ? "" : " ") + op + "[" + edit.token + "]";
  }
  return text;
}

}

TEST(tokenize_splits_runs_of_ascii_and_unicode_whitespace) {
  const std::string text = "a" "\xC2\xA0" "b" "\xE3\x80\x80" "\t" "c"   // U+00A0; U+3000 and a tab are one run
                           "\xC2\x85" "d" "\xE1\xA0\x8E" "e" "\xE2\x80\x8B" "f"   // U+0085, U+180E, U+200B stay in the word
                           "\xEF\xBB\xBF" "g" "\xE2\x80\xA8" "\xF0\x9F\x98\x80" " ";   // U+FEFF, U+2028, then U+1F600 is a word
  CHECK_EQ(tokenize(text), (std::vector<std::string>{"a", "\xC2\xA0", "b", "\xE3\x80\x80\t",
                                                     "c\xC2\x85" "d\xE1\xA0\x8E" "e\xE2\x80\x8B" "f", "\xEF\xBB\xBF", "g",
                                                     "\xE2\x80\xA8", "\xF0\x9F\x98\x80", " "}));
  CHECK_EQ(tokenize(""), std::vector<std::string>{});
}

TEST(edit_script_keeps_equal_tokens_and_deletes_before_it_inserts) {
  const std::vector<Edit> script = editScript(tokenize("the cat sat"), tokenize("the dog sat down"));
  CHECK_EQ(scriptText(script), "=[the] =[ ] -[cat] +[dog] =[ ] =[sat] +[ ] +[down]");
}

TEST(diff3_merges_edits_to_neighbouring_words) {
  const Diff3 merged = diff3("one two", "ONE two", "one TWO", Limits{}.mergeWorkCells);
  CHECK_EQ(merged.text, "ONE TWO");
  CHECK_FALSE(merged.conflict);
}

TEST(diff3_conflict_emits_head_a_blank_line_then_mine_trimmed_at_the_seam) {
  const Diff3 merged = diff3("Mood: fine today", "Mood: great today", "Mood:  tired today", Limits{}.mergeWorkCells);
  CHECK_EQ(merged.text, "Mood: great\n\ntired today");
  CHECK(merged.conflict);
}

TEST(merge_text_refuses_a_revision_that_is_no_longer_kept) {
  CHECK(!mergeText("hello world", 7, TextBase{2, ""}, "hello there", std::nullopt, Limits{}.mergeWorkCells));

  const std::optional<TextMerge> atHead = mergeText("hello world", 7, TextBase{7, ""}, "hello there", std::nullopt, Limits{}.mergeWorkCells);
  REQUIRE(atHead);
  CHECK_EQ(atHead->text, "hello there");
  CHECK_FALSE(atHead->conflict);
  CHECK_EQ(atHead->baseText, "hello world");
}

TEST(merge_text_reads_an_empty_base_as_the_text_the_other_extends) {
  const std::optional<TextMerge> mineExtends = mergeText("a b", 4, TextBase{std::nullopt, ""}, "a b c", std::nullopt, Limits{}.mergeWorkCells);
  REQUIRE(mineExtends);
  CHECK_EQ(mineExtends->text, "a b c");
  CHECK_FALSE(mineExtends->conflict);
  CHECK_EQ(mineExtends->baseText, "a b");

  const std::optional<TextMerge> headExtends = mergeText("a b c", 4, TextBase{std::nullopt, ""}, "a b", std::nullopt, Limits{}.mergeWorkCells);
  REQUIRE(headExtends);
  CHECK_EQ(headExtends->text, "a b c");
  CHECK_FALSE(headExtends->conflict);
  CHECK_EQ(headExtends->baseText, "a b");

  const std::optional<TextMerge> neither = mergeText("x", 4, TextBase{std::nullopt, ""}, "y", std::nullopt, Limits{}.mergeWorkCells);
  REQUIRE(neither);
  CHECK_EQ(neither->text, "x\n\ny");
  CHECK(neither->conflict);
  CHECK_EQ(neither->baseText, "");
  CHECK(mergedFlag(false, "x", *neither));
}

TEST(diff3_past_the_work_bound_on_either_side_is_one_whole_text_conflict) {
  // "a b c" is five tokens: a script from it to a five-token side takes 6 × 6 = 36 cells, to a nine-token side 60.
  const Diff3 atBound = diff3("a b c", "a b x", "y b c", 36);
  CHECK_EQ(atBound.text, std::string("y b x"));
  CHECK_FALSE(atBound.conflict);

  const Diff3 overBound = diff3("a b c", "a b x  ", "\ty b c", 35);
  CHECK_EQ(overBound.text, std::string("a b x\n\ny b c"));
  CHECK(overBound.conflict);

  const Diff3 headOver = diff3("a b c", "a b c d x", "y b c", 36);
  CHECK_EQ(headOver.text, std::string("a b c d x\n\ny b c"));
  CHECK(headOver.conflict);
  const Diff3 mineOver = diff3("a b c", "a b x", "y b c d e", 36);
  CHECK_EQ(mineOver.text, std::string("a b x\n\ny b c d e"));
  CHECK(mineOver.conflict);
}
