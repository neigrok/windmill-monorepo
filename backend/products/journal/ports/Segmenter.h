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
  // Boundary indices the answer named that could not be used — out of range, out of order, or the
  // same one twice. Above zero on an ordinary night means the model is answering about a page it did
  // not read properly.
  int discarded = 0;
};

// Contract every implementation owes: a passage's text is a verbatim, contiguous slice of the body
// and `lo`/`hi` index it exactly.
//
// The Anthropic implementation keeps it by construction rather than by checking: the page is cut
// deterministically into atoms, the atoms are numbered, and the model answers only with the atom
// each unit STARTS at. It is never given a place to put text. (It returned unit strings for a few
// hours on 2026-08-23, checked against the body by `locateUnits`; that made a misquote detectable
// where this makes it impossible.)
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
  // The grammar's version travels, exactly as it does on the Anthropic path: these cuts move when
  // Passage.h's grid moves, and a version that did not move is an archive nobody re-cuts.
  std::string version() const override { return std::string{"rules."} + kAtomGrammarVersion; }

  Segmentation unitsOf(const UserId&, const std::string& body) override {
    return Segmentation{true, "", segment(body, rules_), 0};
  }

private:
  SegmentRules rules_;
};

}
