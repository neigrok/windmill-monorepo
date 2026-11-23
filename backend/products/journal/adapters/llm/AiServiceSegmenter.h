#pragma once

#include "platform/ai_service/AiText.h"
#include "products/journal/ports/Segmenter.h"

#include <memory>
#include <string>

namespace wm {

// A page cut into idea units by a model the AI service serves, as the writer's background work; `RuleSegmenter` runs
// wherever the AI service is not configured. The page is cut into numbered atoms first (`atomsOf`) and the model
// answers only with the atom each unit STARTS at, so it is never given a place to put text: a unit is the writer's own
// bytes by construction rather than by checking. A page with nothing to decide — one short atom, or none — is settled
// here without a call.
class AiServiceSegmenter : public Segmenter {
public:
  explicit AiServiceSegmenter(std::shared_ptr<AiText> ai);

  bool configured() const override;

  // model / effort / atom grammar / prompt tag. The grammar is in there because a page is re-cut
  // only when this string moves: a finer grid that stamped nothing would reach the pages written
  // after it and leave the archive cut the old way.
  std::string version() const override;

  Segmentation unitsOf(const UserId& user, const std::string& body) override;

private:
  std::shared_ptr<AiText> ai_;
};

}
