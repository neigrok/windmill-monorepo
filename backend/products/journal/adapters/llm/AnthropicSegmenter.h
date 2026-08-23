#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "products/journal/ports/Segmenter.h"

#include <memory>
#include <string>

namespace wm {

// Step 1, bought from Anthropic: a page cut into idea units. `RuleSegmenter` runs wherever no key
// is set.
//
// It is the only seam in this product asked to hand back the writer's own words, so its answer is
// checked against them: every unit is located in the body by `locateUnits` and discarded if it is
// not there, byte for byte. The model chooses the CUTS, the body supplies the TEXT.
//
// The transport arrives through the constructor, so the whole boundary stands up in a test against
// canned bytes.
class AnthropicSegmenter : public Segmenter {
public:
  // The fuse and the sink arrive last and default to null, the no-op. This call runs once per page
  // whose BODY moved, which is more often than the curator and on a hotter path, so it is metered
  // the same way.
  explicit AnthropicSegmenter(std::shared_ptr<MessagesApi> transport,
                              std::string model = "claude-sonnet-5", std::string effort = "low",
                              std::shared_ptr<AiFuse> fuse = nullptr,
                              std::shared_ptr<UsageSink> usage = nullptr);

  bool configured() const override;

  // model / effort / prompt tag.
  std::string version() const override;

  Segmentation unitsOf(const UserId& user, const std::string& body) override;

private:
  std::shared_ptr<MessagesApi> transport_;
  std::string model_;
  std::string effort_;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
};

}
