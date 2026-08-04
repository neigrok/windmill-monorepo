#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "products/journal/ports/Curator.h"

#include <memory>
#include <string>
#include <vector>

namespace wm {

// One page's worth of judging, as the model receives it: the text of the call, and the pairings in
// exactly the order they were numbered inside that text. The two travel together because a verdict
// names a pairing by its number, and a number that cannot be resolved back to the pairing it judged
// is a verdict about nothing.
struct CurationPrompt {
  std::string text;
  std::vector<Pairing> numbered;  // numbered[i] is the pairing written as "i + 1." in `text`
};

// Lay out one call. Pure, deterministic, and the place two rules from the design are enforced:
//
//   - candidates are presented oldest first and WITHOUT their cosine or score. Sorted by score with
//     the number attached, the model inherits retrieval's prior and ratifies the top of the list —
//     which is frequently the vocabulary twin the whole call exists to reject.
//   - pairings are numbered in a fixed order that carries no ranking either, so "pairing 1" is not
//     quietly "the one retrieval liked most".
//
// Pairings naming a passage that is in neither list are dropped here rather than sent: there is no
// text to judge them against.
CurationPrompt curationPrompt(const std::vector<Vectored>& tonight,
                              const std::vector<Vectored>& candidates,
                              const std::vector<Pairing>& proposed);

// The curator, bought from Anthropic. It asks one question per changed page and settles the two
// things a cosine cannot — same subject or merely same words, and whose voice the older passage is.
// It writes no copy, and nothing it returns is shown to anyone: the sweep stores flags, and the page
// shows the user's own two passages.
//
// The transport arrives through the constructor, so the whole boundary stands up in a test against
// canned bytes and nothing here needs a network to be trusted.
class AnthropicCurator : public Curator {
public:
  // `effort` is a knob, not a setting: ECHOES wants the levels swept and the quality delta measured
  // before one is defaulted, and rejecting vocabulary twins is the kind of task the low end of this
  // model is unusually good at. Until that sweep happens the default is the API's own, so this file
  // asserts nothing nobody measured.
  explicit AnthropicCurator(std::shared_ptr<MessagesApi> transport,
                            std::string model = "claude-opus-5", std::string effort = "high");

  bool configured() const override;

  // model / effort / prompt tag — every input that can change a judgement, in one greppable string.
  // A persisted graph accumulates rows judged by different vintages over years; without all three a
  // mixed chain cannot be selectively rebuilt.
  std::string version() const override;

  Curation curate(const std::vector<Vectored>& tonight, const std::vector<Vectored>& candidates,
                  const std::vector<Pairing>& proposed) override;

private:
  std::shared_ptr<MessagesApi> transport_;
  std::string model_;
  std::string effort_;
};

}
