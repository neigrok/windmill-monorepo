#include "products/journal/adapters/llm/AnthropicSegmenter.h"

#include "test/testing.h"

#include <json/json.h>

#include <memory>
#include <string>
#include <vector>

using namespace wm;

namespace {

// The transport, faked; its bytes go through the real reader, so every failure word here is the one the live edge produces.
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

MessagesReply answering(const std::vector<std::string>& units) {
  MessagesReply reply;
  reply.ok = true;
  reply.output = Json::Value(Json::objectValue);
  reply.output["units"] = Json::Value(Json::arrayValue);
  for (const std::string& unit : units) reply.output["units"].append(unit);
  return reply;
}

MessagesReply failing(const char* failure) {
  MessagesReply reply;
  reply.ok = false;
  reply.failure = failure;
  return reply;
}

const std::string kBody = "заебался, нет сил продолжать. еще и заболел вчера";

}

TEST(the_segmenter_cuts_a_page_into_the_units_the_model_named) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = answering({"заебался, нет сил продолжать.", "еще и заболел вчера"});
  AnthropicSegmenter segmenter{transport};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  CHECK_EQ(cut.ok, true);
  CHECK_EQ(cut.discarded, 0);
  REQUIRE_EQ(cut.passages.size(), std::size_t{2});
  CHECK_EQ(cut.passages[0].text, std::string{"заебался, нет сил продолжать."});
  CHECK_EQ(cut.passages[1].text, std::string{"еще и заболел вчера"});
  REQUIRE_EQ(transport->sent.size(), std::size_t{1});
  CHECK_EQ(transport->sent[0].user, kBody);
  CHECK(transport->sent[0].system.find("idea units") != std::string::npos);
  CHECK(transport->sent[0].system.find(kBody) == std::string::npos);
}

TEST(a_unit_the_model_reworded_is_discarded_and_counted) {
  auto transport = std::make_shared<FakeMessages>();
  // The first unit is the page tidied, so it is not what the writer wrote and cannot become a passage.
  transport->reply = answering({"устал, нет сил продолжать.", "еще и заболел вчера"});
  AnthropicSegmenter segmenter{transport};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  CHECK_EQ(cut.ok, true);
  CHECK_EQ(cut.discarded, 1);
  REQUIRE_EQ(cut.passages.size(), std::size_t{1});
  CHECK_EQ(cut.passages[0].text, std::string{"еще и заболел вчера"});
}

TEST(a_page_whose_every_unit_was_rewritten_is_a_failed_call_not_an_empty_page) {
  auto transport = std::make_shared<FakeMessages>();
  transport->reply = answering({"i was tired", "and then i got sick"});
  AnthropicSegmenter segmenter{transport};

  const Segmentation cut = segmenter.unitsOf(UserId{"u1"}, kBody);

  // Stored as an empty page this would SETTLE the page: it is a failure, so the page stays owed.
  CHECK_EQ(cut.ok, false);
  CHECK_EQ(cut.failure, std::string{"schema_invalid"});
  CHECK_EQ(cut.discarded, 2);
  CHECK_EQ(cut.passages.empty(), true);
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
  CHECK_EQ(one.version().substr(one.version().rfind('/')),
           other.version().substr(other.version().rfind('/')));
}
