#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "products/journal/ports/Curator.h"

#include <memory>
#include <string>
#include <vector>

namespace wm {

// One page's worth of judging, as the model receives it: the text of the call, and the pairings in
// exactly the order they were numbered inside that text. A verdict names a pairing by its number.
struct CurationPrompt {
  std::string text;
  std::vector<Pairing> numbered;  // numbered[i] is the pairing written as "i + 1." in `text`
};

// Lay out one call. Pure, deterministic, and the place two rules are enforced:
//
//   - candidates are presented oldest first and WITHOUT their cosine or score, so the model does
//     not inherit retrieval's prior and ratify the top of the list;
//   - pairings are numbered in a fixed order that carries no ranking either.
//
// Pairings naming a passage that is in neither list are dropped here rather than sent: there is no
// text to judge them against.
CurationPrompt curationPrompt(const std::vector<Vectored>& tonight,
                              const std::vector<Vectored>& candidates,
                              const std::vector<Pairing>& proposed);

// The curator, bought from Anthropic. It asks one question per changed page and settles the two
// things a cosine cannot — same subject or merely same words, and whose voice the older passage is.
// Nothing it returns is shown to anyone: the sweep stores flags, and the page shows the user's own
// two passages.
//
// The transport arrives through the constructor, so the whole boundary stands up in a test against
// canned bytes.
class AnthropicCurator : public Curator {
public:
  // Sonnet 5 at `low` is an owner decision taken for LATENCY, not a measured one: the curator
  // precision gate (>=0.85) has never been run, so treat the pair as unverified.
  //
  // The fuse and the sink arrive last and default to null, the no-op. This seam spends money nobody
  // asked it to — it runs six-hourly over pages no writer requested a pass on — so it is metered.
  //
  // `floor` is the least `relation` a pairing may carry and still be shown. The prompt defines the
  // ABSOLUTE scale the number sits on, so the floor lives beside it: move one and you move both.
  explicit AnthropicCurator(std::shared_ptr<MessagesApi> transport,
                            std::string model = "claude-sonnet-5", std::string effort = "low",
                            std::shared_ptr<AiFuse> fuse = nullptr,
                            std::shared_ptr<UsageSink> usage = nullptr, float floor = 0.6f);

  bool configured() const override;

  // model / effort / prompt tag — every input that can change a judgement, in one greppable string,
  // so a graph of mixed vintages can be selectively rebuilt.
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
