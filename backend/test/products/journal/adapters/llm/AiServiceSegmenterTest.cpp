#include "products/journal/adapters/llm/AiServiceSegmenter.h"

#include "platform/adapters/json/JsonText.h"
#include "test/testing.h"

#include <json/json.h>

#include <memory>
#include <string>
#include <utility>
#include <vector>

using namespace wm;

namespace {

// The AI service's text door, played: it keeps every question and answers each with `answer`.
struct FakeAiText : AiText {
  TextAnswer answer{"completed", ""};
  std::vector<std::pair<UserId, TextQuestion>> asked;

  TextAnswer ask(const UserId& account, const TextQuestion& question) override {
    asked.emplace_back(account, question);
    return answer;
  }
};

// The model answers with NUMBERS — which atom each idea unit starts at. It is never given a place
// to put text, which is what makes a misquote impossible rather than merely detectable.
TextAnswer answering(const std::vector<int>& starts) {
  Json::Value output(Json::objectValue);
  output["starts"] = Json::Value(Json::arrayValue);
  for (const int start : starts) output["starts"].append(start);
  return {"completed", dump(output)};
}

// Four atoms, three thoughts: the wish and the objection to it are one unit, which is the whole
// product requirement, and the other two stand alone.
const std::string kBody =
    "заебался, нет сил продолжать. еще и заболел вчера.\n"
    "хочется в сербию. но это ничего не решит.";

}

TEST(the_segmenter_groups_numbered_atoms_and_never_touches_the_text) {
  auto ai = std::make_shared<FakeAiText>();
  ai->answer = answering({1, 2, 3});
  AiServiceSegmenter segmenter{ai};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  CHECK_EQ(cut.ok, true);
  CHECK_EQ(cut.discarded, 0);
  REQUIRE_EQ(cut.passages.size(), std::size_t{3});
  CHECK_EQ(cut.passages[0].text, std::string{"заебался, нет сил продолжать."});
  CHECK_EQ(cut.passages[1].text, std::string{"еще и заболел вчера."});
  // The third unit runs to the end of the page: two sentences, one thought.
  CHECK_EQ(cut.passages[2].text, std::string{"хочется в сербию. но это ничего не решит."});
  // Every unit is the body's own bytes at its own offsets — the guarantee that used to need a
  // search through the page to check.
  for (const Passage& unit : cut.passages)
    CHECK_EQ(kBody.substr(unit.lo, unit.hi - unit.lo), unit.text);

  // What travels is the numbered page, as the writer's own background work, and the instruction
  // never gains a byte from it.
  REQUIRE_EQ(ai->asked.size(), std::size_t{1});
  const auto& [account, question] = ai->asked[0];
  CHECK(account == UserId{"u1"});
  CHECK_EQ(question.user, std::string{"1. заебался, нет сил продолжать.\n"
                                      "2. еще и заболел вчера.\n"
                                      "3. хочется в сербию.\n"
                                      "4. но это ничего не решит.\n"});
  CHECK(question.system.find("idea units") != std::string::npos);
  CHECK(question.system.find(kBody) == std::string::npos);
  CHECK_EQ(question.label + " " + question.operation + " " + question.model + " " + question.effort + " " +
               (question.cache ? "cached" : "uncached") + " " + std::to_string(question.maxTokens) + " " + dump(question.schema),
           std::string{R"(echoes echo.segment medium low uncached 16000 {"additionalProperties":false,)"
                       R"("properties":{"starts":{"items":{"type":"integer"},"type":"array"}},"required":["starts"],"type":"object"})"});
}

TEST(a_page_the_model_reads_as_one_thought_is_stored_as_the_whole_page) {
  auto ai = std::make_shared<FakeAiText>();
  ai->answer = answering({1});
  AiServiceSegmenter segmenter{ai};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  REQUIRE_EQ(cut.passages.size(), std::size_t{1});
  CHECK_EQ(cut.passages[0].lo, 0);
  CHECK_EQ(cut.passages[0].hi, static_cast<int>(kBody.size()));
}

// The whole point of answering in numbers: a confused answer can group thoughts badly and cannot
// misquote anybody, so it is repaired rather than refused. Every partition of the page's own atoms
// is made of the page's own bytes.
TEST(a_nonsense_answer_is_repaired_rather_than_believed_or_refused) {
  auto ai = std::make_shared<FakeAiText>();
  ai->answer = answering({7, 3, 3, 0, -2, 2});
  AiServiceSegmenter segmenter{ai};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  CHECK_EQ(cut.ok, true);
  // 7, 0 and -2 name no atom on this page, and the repeated 3 opens one unit rather than two.
  CHECK_EQ(cut.discarded, 4);
  // What is left is sorted and deduped, and atom 1 opens a unit whether or not it was named.
  REQUIRE_EQ(cut.passages.size(), std::size_t{3});
  CHECK_EQ(cut.passages[0].lo, 0);
  CHECK_EQ(cut.passages.back().hi, static_cast<int>(kBody.size()));
  // And the units still tile the page in order: nothing the writer wrote fell out of the index.
  for (std::size_t i = 1; i < cut.passages.size(); ++i)
    CHECK(cut.passages[i].lo > cut.passages[i - 1].lo);
}

TEST(a_short_single_atom_is_answered_without_asking_the_vendor_anything) {
  auto ai = std::make_shared<FakeAiText>();
  AiServiceSegmenter segmenter{ai};

  const std::string body = "хочется уже в сербию";
  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, body);

  CHECK_EQ(cut.ok, true);
  REQUIRE_EQ(cut.passages.size(), std::size_t{1});
  CHECK_EQ(cut.passages[0].text, body);
  // One short atom has one legal answer, so there is nothing to buy. Measured on a real diary, one
  // page in six is a single line.
  CHECK(wordsIn(body) <= kLongAtomWords);
  CHECK_EQ(ai->asked.empty(), true);
}

// The page the old rule was worst on: the grammar found no seam in it, so it arrived as ONE atom —
// and one atom was the exact condition for never showing it to anybody. It is the most diluted page
// in the corpus and it was the one page guaranteed not to be looked at.
TEST(a_long_single_atom_is_shown_to_the_vendor_instead_of_settling_unread) {
  auto ai = std::make_shared<FakeAiText>();
  ai->answer = answering({1});
  AiServiceSegmenter segmenter{ai};

  const std::string body =
      "сегодня я весь день сидел и переделывал этот чертов бэкенд и все равно "
      "ничего толком не заработало и я просто закрыл ноут и пошел спать без сил";
  REQUIRE_EQ(atomsOf(body).size(), std::size_t{1});
  CHECK(wordsIn(body) > kLongAtomWords);

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, body);

  CHECK_EQ(cut.ok, true);
  REQUIRE_EQ(ai->asked.size(), std::size_t{1});
  REQUIRE_EQ(cut.passages.size(), std::size_t{1});
  CHECK_EQ(cut.passages[0].text, body);
}

// The one reply repair cannot tell from a considered answer: `unitsFrom` opens at atom 1 with an
// empty list, so a page that got NO decision would settle byte-identical to one the model read and
// judged whole. It stays owed instead.
TEST(an_empty_answer_on_a_page_with_boundaries_is_a_failed_call) {
  auto ai = std::make_shared<FakeAiText>();
  ai->answer = answering({});
  AiServiceSegmenter segmenter{ai};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  CHECK_EQ(cut.ok, false);
  CHECK_EQ(cut.failure, std::string{"unreadable"});
  CHECK_EQ(cut.passages.empty(), true);
  // The call was still made and still costs: it is the page that is refused, not the request.
  CHECK_EQ(ai->asked.size(), std::size_t{1});
}

TEST(a_blank_page_is_settled_without_asking_the_vendor_anything) {
  auto ai = std::make_shared<FakeAiText>();
  AiServiceSegmenter segmenter{ai};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, "   \n\t  ");

  CHECK_EQ(cut.ok, true);
  CHECK_EQ(cut.passages.empty(), true);
  CHECK_EQ(ai->asked.empty(), true);
}

TEST(a_call_that_ended_without_an_answer_fails_with_the_services_own_word) {
  auto ai = std::make_shared<FakeAiText>();
  AiServiceSegmenter segmenter{ai};

  std::string failed;
  for (const std::string code : {"background_exhausted", "truncated", "declined", "unreachable"}) {
    ai->answer = {code, ""};
    const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);
    failed += code + " " + (cut.ok ? "ok" : "failed") + " " + cut.failure + " " + std::to_string(cut.passages.size()) + "\n";
  }

  CHECK_EQ(failed, std::string{"background_exhausted failed background_exhausted 0\n"
                               "truncated failed truncated 0\n"
                               "declined failed declined 0\n"
                               "unreachable failed unreachable 0\n"});
}

TEST(an_answer_that_is_not_a_list_of_numbers_at_all_is_a_failed_call) {
  auto ai = std::make_shared<FakeAiText>();
  AiServiceSegmenter segmenter{ai};

  // Repair is for an answer of the right SHAPE carrying wrong numbers, and only where at least one
  // of them is usable. A reply that is not that shape, or no JSON at all, is a call that failed,
  // and the page stays owed.
  for (const std::string text : {R"({"starts":"one, and then three"})", "I grouped them for you.", "[1,3]"}) {
    ai->answer = {"completed", text};
    const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);
    CHECK_EQ(cut.ok, false);
    CHECK_EQ(cut.failure, std::string{"unreadable"});
  }
}

// A stored page is cut again when this string moves, so it pins the bytes every stored cut carries: the model the AI
// service serves `medium` from, the effort, the atom grammar and the prompt's digest (echoes-on-ai-service.md §6).
TEST(the_version_names_the_served_model_the_effort_the_atom_grammar_and_the_prompt) {
  const AiServiceSegmenter segmenter{std::make_shared<FakeAiText>()};

  CHECK_EQ(segmenter.version(), std::string{"claude-sonnet-5/low/atoms.v3/9b1bc905"});
  CHECK_EQ(std::string{kAtomGrammarVersion}, std::string{"atoms.v3"});
}
