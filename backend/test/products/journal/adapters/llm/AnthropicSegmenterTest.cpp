#include "products/journal/adapters/llm/AnthropicSegmenter.h"

#include "test/testing.h"

#include <json/json.h>

#include <memory>
#include <string>
#include <vector>

using namespace wm;

namespace {

// The transport, faked; its bytes go through the real reader, so every failure word here is the one
// the live edge produces.
struct FakeMessages : MessagesApi {
  bool ready = true;
  MessagesReply reply;
  std::vector<MessagesRequest> sent;

  bool configured() const override { return ready; }

  MessagesReply send(const MessagesRequest& request) override {
    sent.push_back(request);
    return reply;
  }
};

// The model answers with NUMBERS — which sentence each idea unit starts at. It is never given a
// place to put text, which is what makes a misquote impossible rather than merely detectable.
MessagesReply answering(const std::vector<int>& starts) {
  MessagesReply reply;
  reply.ok = true;
  reply.output = Json::Value(Json::objectValue);
  reply.output["starts"] = Json::Value(Json::arrayValue);
  for (const int start : starts) reply.output["starts"].append(start);
  return reply;
}

MessagesReply failing(const char* failure) {
  MessagesReply reply;
  reply.ok = false;
  reply.failure = failure;
  return reply;
}

// Four sentences, three thoughts: the wish and the objection to it are one unit, which is the whole
// product requirement, and the other two stand alone.
const std::string kBody =
    "заебался, нет сил продолжать. еще и заболел вчера.\n"
    "хочется в сербию. но это ничего не решит.";

}

TEST(the_segmenter_groups_numbered_sentences_and_never_touches_the_text) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = answering({1, 2, 3});
  AnthropicSegmenter segmenter{transport};

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

  // What travels is the numbered page, and the instruction never gains a byte from it.
  REQUIRE_EQ(transport->sent.size(), std::size_t{1});
  CHECK(transport->sent[0].user.rfind("1. заебался", 0) == 0);
  CHECK(transport->sent[0].user.find("4. но это ничего не решит.") != std::string::npos);
  CHECK(transport->sent[0].system.find("idea units") != std::string::npos);
  CHECK(transport->sent[0].system.find(kBody) == std::string::npos);
}

TEST(a_page_the_model_reads_as_one_thought_is_stored_as_the_whole_page) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = answering({1});
  AnthropicSegmenter segmenter{transport};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  REQUIRE_EQ(cut.passages.size(), std::size_t{1});
  CHECK_EQ(cut.passages[0].lo, 0);
  CHECK_EQ(cut.passages[0].hi, static_cast<int>(kBody.size()));
}

// The whole point of answering in numbers: a confused answer can group thoughts badly and cannot
// misquote anybody, so it is repaired rather than refused. Every partition of the page's own
// sentences is made of the page's own bytes.
TEST(a_nonsense_answer_is_repaired_rather_than_believed_or_refused) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = answering({7, 3, 3, 0, -2, 2});
  AnthropicSegmenter segmenter{transport};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  CHECK_EQ(cut.ok, true);
  // 7, 0 and -2 name no sentence on this page, and the repeated 3 opens one unit rather than two.
  CHECK_EQ(cut.discarded, 4);
  // What is left is sorted and deduped, and sentence 1 opens a unit whether or not it was named.
  REQUIRE_EQ(cut.passages.size(), std::size_t{3});
  CHECK_EQ(cut.passages[0].lo, 0);
  CHECK_EQ(cut.passages.back().hi, static_cast<int>(kBody.size()));
  // And the units still tile the page in order: nothing the writer wrote fell out of the index.
  for (std::size_t i = 1; i < cut.passages.size(); ++i)
    CHECK(cut.passages[i].lo > cut.passages[i - 1].lo);
}

TEST(a_one_sentence_page_is_answered_without_asking_the_vendor_anything) {
  auto transport = std::make_shared<FakeMessages>();
  AnthropicSegmenter segmenter{transport};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, "хочется уже в сербию");

  CHECK_EQ(cut.ok, true);
  REQUIRE_EQ(cut.passages.size(), std::size_t{1});
  CHECK_EQ(cut.passages[0].text, std::string{"хочется уже в сербию"});
  // One sentence has no boundary to decide, so there is nothing to buy an answer about. Measured on
  // a real diary, one page in six is a single line.
  CHECK_EQ(transport->sent.empty(), true);
}

TEST(a_blank_page_is_settled_without_asking_the_vendor_anything) {
  auto transport = std::make_shared<FakeMessages>();
  AnthropicSegmenter segmenter{transport};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, "   \n\t  ");

  CHECK_EQ(cut.ok, true);
  CHECK_EQ(cut.passages.empty(), true);
  CHECK_EQ(transport->sent.empty(), true);
}

TEST(a_vendor_failure_leaves_the_page_owed) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = failing(MessagesFailure::rateLimited);
  AnthropicSegmenter segmenter{transport};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  CHECK_EQ(cut.ok, false);
  CHECK_EQ(cut.failure, std::string{"rate_limited"});
  CHECK_EQ(cut.passages.empty(), true);
}

TEST(an_answer_that_is_not_a_list_of_numbers_at_all_is_a_failed_call) {
  auto transport = std::make_shared<FakeMessages>();
  MessagesReply nonsense;
  nonsense.ok = true;
  nonsense.output = Json::Value(Json::objectValue);
  nonsense.output["starts"] = "one, and then three";
  transport->reply = nonsense;
  AnthropicSegmenter segmenter{transport};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  // Repair is for an answer of the right SHAPE carrying wrong numbers. A reply that is not that
  // shape is a call that failed, and the page stays owed.
  CHECK_EQ(cut.ok, false);
  CHECK_EQ(cut.failure, std::string{"schema_invalid"});
}

TEST(an_unconfigured_transport_fails_rather_than_reporting_an_empty_page) {
  auto transport = std::make_shared<FakeMessages>();
  transport->ready = false;
  AnthropicSegmenter segmenter{transport};

  CHECK_EQ(segmenter.configured(), false);
  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);
  CHECK_EQ(cut.ok, false);
  CHECK_EQ(cut.failure, std::string{"transport"});
  CHECK_EQ(transport->sent.empty(), true);
}

TEST(the_version_names_the_model_the_effort_and_the_prompt) {
  auto transport = std::make_shared<FakeMessages>();
  AnthropicSegmenter one{transport, "claude-sonnet-5", "low"};
  AnthropicSegmenter other{transport, "claude-opus-5", "high"};

  CHECK(one.version().rfind("claude-sonnet-5/low/", 0) == 0);
  CHECK(other.version().rfind("claude-opus-5/high/", 0) == 0);
  // Same prompt, so the tag — the last segment — is the same on both.
  CHECK_EQ(one.version().substr(one.version().rfind('/')),
           other.version().substr(other.version().rfind('/')));
}
