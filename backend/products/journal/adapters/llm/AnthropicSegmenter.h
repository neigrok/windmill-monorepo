#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "products/journal/ports/Segmenter.h"

#include <memory>
#include <string>

namespace wm {

// A page cut into idea units; `RuleSegmenter` runs wherever no key is set. The page is cut into
// numbered atoms first (`atomsOf`) and the model answers only with the atom each unit STARTS at, so
// it is never given a place to put text: a unit is the writer's own bytes by construction rather
// than by checking. A page with nothing to decide — one short atom, or none — is settled here
// without a call.
class AnthropicSegmenter : public Segmenter {
public:
  // The fuse and the sink default to null, the no-op.
  explicit AnthropicSegmenter(std::shared_ptr<MessagesApi> transport,
                              std::string model = "claude-sonnet-5", std::string effort = "low",
                              std::shared_ptr<AiFuse> fuse = nullptr,
                              std::shared_ptr<UsageSink> usage = nullptr);

  bool configured() const override;

  // model / effort / atom grammar / prompt tag. The grammar is in there because a page is re-cut
  // only when this string moves: a finer grid that stamped nothing would reach the pages written
  // after it and leave the archive cut the old way.
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
