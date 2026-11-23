#pragma once

#include "platform/ai_service/AiText.h"
#include "products/journal/ports/Curator.h"

#include <memory>
#include <string>
#include <vector>

namespace wm {

// One call's text plus the pairings in the order they were numbered inside it. A verdict names a
// pairing by its number.
struct CurationPrompt {
  std::string text;
  std::vector<Pairing> numbered;  // numbered[i] is the pairing written as "i + 1." in `text`
};

// Candidates are presented oldest first and without their cosine or score; pairing numbers carry
// no ranking. Pairings naming a passage in neither list are dropped rather than sent.
CurationPrompt curationPrompt(const std::vector<Vectored>& tonight,
                              const std::vector<Vectored>& candidates,
                              const std::vector<Pairing>& proposed);

// One call per changed page to a model the AI service serves, as the writer's background work, judging same-subject and
// whose voice the older passage is. Nothing it returns is shown to a reader: the sweep stores flags and the page shows
// the writer's own passages.
class AiServiceCurator : public Curator {
public:
  // `floor` is the least `relation` a pairing may carry and still be shown, on the absolute scale the prompt defines:
  // move one and move both.
  explicit AiServiceCurator(std::shared_ptr<AiText> ai, float floor = 0.6f);

  bool configured() const override;

  // model / effort / prompt tag / relation floor in thousandths.
  std::string version() const override;

  Curation curate(const UserId& user, const std::vector<Vectored>& tonight,
                  const std::vector<Vectored>& candidates,
                  const std::vector<Pairing>& proposed) override;

private:
  std::shared_ptr<AiText> ai_;
  float floor_ = 0.6f;
};

}
