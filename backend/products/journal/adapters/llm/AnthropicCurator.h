#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
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

// One call per changed page, judging same-subject and whose voice the older passage is. Nothing it
// returns is shown to a reader: the sweep stores flags and the page shows the writer's own passages.
class AnthropicCurator : public Curator {
public:
  // The fuse and the sink default to null, the no-op. `floor` is the least `relation` a pairing may
  // carry and still be shown, on the absolute scale the prompt defines: move one and move both.
  explicit AnthropicCurator(std::shared_ptr<MessagesApi> transport,
                            std::string model = "claude-sonnet-5", std::string effort = "low",
                            std::shared_ptr<AiFuse> fuse = nullptr,
                            std::shared_ptr<UsageSink> usage = nullptr, float floor = 0.6f);

  bool configured() const override;

  // model / effort / prompt tag / relation floor in thousandths.
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
