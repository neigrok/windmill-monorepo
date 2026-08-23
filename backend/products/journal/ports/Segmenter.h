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
  std::string failure;              // the MessagesFailure words, so the sweep branches on one set
  std::vector<Passage> passages;
  int discarded = 0;                // units the model returned that are NOT in the body — dropped
};

// A passage is one idea unit — what a person would call one thought.
//
// Contract every implementation owes: a passage's text is a VERBATIM, CONTIGUOUS slice of the body
// and `lo`/`hi` index it exactly — the client re-locates the quote by text, dismissals are keyed on
// content, and a redaction propagates because the text stops being found. `locateUnits`
// (domain/Passage.h) checks every unit against the body and discards what does not appear.
struct Segmenter {
  virtual ~Segmenter() = default;
  virtual bool configured() const = 0;

  // Not stamped on any row yet (see ECHOES.md, "Segmentation"): a page is due on its body or its
  // corpus moving, never on the segmenter changing. Clearing journal_page_curation re-derives all.
  virtual std::string version() const = 0;

  // `user` attributes the call's spend to an account.
  virtual Segmentation unitsOf(const UserId& user, const std::string& body) = 0;
};

// The unwired path — local runs, tests, and any deploy without an Anthropic key. It satisfies the
// verbatim contract by construction: `segment` only ever returns slices of the body.
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
