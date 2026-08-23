#pragma once

#include "platform/domain/Ids.h"
#include "products/journal/domain/Passage.h"

#include <string>
#include <vector>

namespace wm {

// One page cut into the units retrieval reasons over. `ok` false means the CALL failed and the page
// is still owed; an `ok` call with no passages is a page with nothing on it.
struct Segmentation {
  bool ok = false;
  std::string failure;              // the MessagesFailure words
  std::vector<Passage> passages;
  int discarded = 0;                // units the model returned that are NOT in the body — dropped
};

// Contract every implementation owes: a passage's text is a verbatim, contiguous slice of the body
// and `lo`/`hi` index it exactly. `locateUnits` checks every unit and discards what does not appear.
struct Segmenter {
  virtual ~Segmenter() = default;
  virtual bool configured() const = 0;

  // Stamped on the page's curation row; a page whose stored segment_version differs is due again.
  virtual std::string version() const = 0;

  // `user` attributes the call's spend to an account.
  virtual Segmentation unitsOf(const UserId& user, const std::string& body) = 0;
};

// The unwired path. Satisfies the verbatim contract by construction: `segment` only returns slices
// of the body.
class RuleSegmenter : public Segmenter {
public:
  explicit RuleSegmenter(SegmentRules rules = {}) : rules_(rules) {}

  bool configured() const override { return true; }
  std::string version() const override { return "rules.lines-sentences.v1"; }

  Segmentation unitsOf(const UserId&, const std::string& body) override {
    return Segmentation{true, "", segment(body, rules_), 0};
  }

private:
  SegmentRules rules_;
};

}
