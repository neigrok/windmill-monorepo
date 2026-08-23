#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "products/journal/ports/Segmenter.h"

#include <memory>
#include <string>

namespace wm {

// A page cut into idea units; `RuleSegmenter` runs wherever no key is set. Every unit the model
// returns is located in the body by `locateUnits` and discarded if it is not there byte for byte.
class AnthropicSegmenter : public Segmenter {
public:
  // The fuse and the sink default to null, the no-op.
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
