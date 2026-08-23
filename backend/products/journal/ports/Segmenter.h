#pragma once

#include "platform/domain/Ids.h"
#include "products/journal/domain/Passage.h"

#include <string>
#include <vector>

namespace wm {

// One page cut into the units retrieval reasons over. `ok` false means the CALL failed and the page
// is still owed — never a page with no units, which would settle it and lose the night. An `ok`
// call with no passages is a page with nothing on it, which is a finished answer.
struct Segmentation {
  bool ok = false;
  std::string failure;              // the MessagesFailure words, so the sweep branches on one set
  std::vector<Passage> passages;
  int discarded = 0;                // units the model returned that are NOT in the body — dropped
};

// WHERE A PASSAGE COMES FROM, and since 2026-08-23 it is a model rather than a rule.
//
// The rule that preceded it cut on line breaks and then on sentences, up to three to a passage. That
// is right for long-form prose and wrong for a diary: measured on a real page, three unrelated
// thoughts — being exhausted, having got sick, wanting to go and drink wine somewhere — landed in
// ONE passage, and mean pooling averaged them into a vector that matched the writer's own sentence
// back at 0.354 where the sentence alone matched at 0.950. Retrieval never saw the thought, and no
// threshold downstream could have rescued it.
//
// An idea unit is what a person would call one thought: a claim and the objection they immediately
// raise against it belong together; two unrelated sentences on one line do not.
//
// THE ONE CONTRACT EVERY IMPLEMENTATION OWES: a passage's text is a VERBATIM, CONTIGUOUS slice of
// the body, and `lo`/`hi` index it exactly. The whole pipeline downstream rests on it — the client
// re-locates the quote by text and shows it only if it is still there, dismissals are keyed on
// content, and a redaction propagates because the text stops being found. A model that paraphrases
// a unit has produced something the reader never wrote, so `locateUnits` (domain/Passage.h) checks
// every unit against the body and discards what does not appear. It is not a formatting nicety; it
// is what keeps this seam from putting words in the writer's mouth.
struct Segmenter {
  virtual ~Segmenter() = default;
  virtual bool configured() const = 0;

  // Stamped nowhere yet, and that is a known gap — see ECHOES.md, "Segmentation". A page is due on
  // its body or its corpus moving, never on the segmenter changing, so a new version reaches old
  // pages only when they are next edited. The operator's lever until that is fixed is clearing
  // journal_page_curation, which makes every page never-derived.
  virtual std::string version() const = 0;

  // `user` is whose page this is, for the same reason the curator takes one: the call costs money
  // and a spend with nobody attached is a number nobody can be held to.
  virtual Segmentation unitsOf(const UserId& user, const std::string& body) = 0;
};

// The rule that used to be the whole of step 1, kept as the unwired path — local runs, tests, and
// any deploy without an Anthropic key, where the curator is dark anyway and no echo can arrive. It
// satisfies the verbatim contract by construction: `segment` only ever returns slices of the body.
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
