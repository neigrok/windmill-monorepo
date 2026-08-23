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
  // Sonnet 5 at `low`, and both halves of that are an owner decision taken for LATENCY, not a
  // measured one. The sweep ECHOES asks for has still not been run: nobody has compared this pair's
  // precision against Opus 5 at `high` on a labelled set, and the pre-ship gate (curator precision
  // ≥0.85) is the thing that would catch it if the trade went badly. Treat the pair as unverified.
  //
  // The fuse and the sink arrive last and default to null, which is the no-op — the same discipline
  // FailureReporter already keeps everywhere else. This seam is the one that spends money nobody
  // asked it to: it runs six-hourly against pages the writer never requested a pass over, so it is
  // the seam a runaway most easily hides in and the one whose spend is least likely to be noticed.
  // `floor` is the least `relation` a pairing may carry and still be shown. The prompt defines an
  // ABSOLUTE scale — 0.9+ the same specific thing, 0.6-0.8 that thing seen later, 0.3-0.5 the same
  // theme and not the same subject — so the floor sits above the theme band. It lives beside the
  // prompt because the prompt is what gives the number its meaning; move one and you move both.
  explicit AnthropicCurator(std::shared_ptr<MessagesApi> transport,
                            std::string model = "claude-sonnet-5", std::string effort = "low",
                            std::shared_ptr<AiFuse> fuse = nullptr,
                            std::shared_ptr<UsageSink> usage = nullptr, float floor = 0.6f);

  bool configured() const override;

  // model / effort / prompt tag — every input that can change a judgement, in one greppable string.
  // A persisted graph accumulates rows judged by different vintages over years; without all three a
  // mixed chain cannot be selectively rebuilt.
  std::string version() const override;

  Curation curate(const UserId& user, const std::vector<Vectored>& tonight,
                  const std::vector<Vectored>& candidates,
                  const std::vector<Pairing>& proposed) override;

private:
  std::shared_ptr<MessagesApi> transport_;
  std::string model_;
  std::string effort_;
  float floor_ = 0.6f;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
};

}
