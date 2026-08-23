#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "products/journal/ports/Segmenter.h"

#include <memory>
#include <string>

namespace wm {

// Step 1, bought from Anthropic since 2026-08-23: a page cut into idea units rather than into
// lines and sentences. The rule it replaced is still here as `RuleSegmenter` and still runs
// wherever no key is set.
//
// It is the only seam in this product that is asked to hand back the writer's own words, so it is
// the only one whose answer is checked against them: every unit is located in the body by
// `locateUnits` and discarded if it is not there, byte for byte. Nothing this class returns has
// been through the model's hands — the model chooses the CUTS, the body supplies the TEXT.
//
// The transport arrives through the constructor, so the whole boundary stands up in a test against
// canned bytes and nothing here needs a network to be trusted.
class AnthropicSegmenter : public Segmenter {
public:
  // Sonnet 5 at `low`. Cutting a page into thoughts is a shallower question than judging whether
  // two passages share a subject, and it sits in front of a writer who has just stopped typing —
  // the same latency argument that put the curator on this pair, with more of a case for it.
  //
  // The fuse and the sink arrive last and default to null, the no-op. This call runs once per page
  // whose BODY moved, which is more often than the curator runs and on a hotter path, so it is
  // metered for the same reason: a vendor call this process cannot see the cost of is one it
  // cannot stop.
  explicit AnthropicSegmenter(std::shared_ptr<MessagesApi> transport,
                              std::string model = "claude-sonnet-5", std::string effort = "low",
                              std::shared_ptr<AiFuse> fuse = nullptr,
                              std::shared_ptr<UsageSink> usage = nullptr);

  bool configured() const override;

  // model / effort / prompt tag, the shape the curator's version already has. Nothing stamps it on
  // a row yet — ECHOES.md, "Segmentation", states that gap and the operator's lever for it.
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
