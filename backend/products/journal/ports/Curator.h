#pragma once

#include "platform/domain/Ids.h"
#include "products/journal/domain/EchoSelection.h"

#include <cstdint>
#include <string>
#include <vector>

namespace wm {

// `related`: the two passages share a subject, not merely vocabulary, and are about the same
// life — a pairing about someone else's is not related.
// `speakerIsSelf`: the older passage is the writer's own voice, not something they copied down.
struct Verdict {
  std::int64_t triggerSpanId = 0;
  std::int64_t matchSpanId = 0;
  bool related = false;
  // How strongly the pairing holds, on an ABSOLUTE scale the curator's prompt defines: 0.9+ the
  // same specific thing, 0.6-0.8 that thing seen later, 0.3-0.5 the same theme and not the same
  // subject. The floor lives beside the prompt that gives the number its meaning (AnthropicCurator).
  float relation = 0.0f;
  bool speakerIsSelf = true;
};

// `ok` false means the CALL failed, not that nothing was found: that page must be retried.
struct Curation {
  bool ok = false;
  std::string failure;         // transport | rate_limited | truncated | schema_invalid | refused
  std::vector<Verdict> verdicts;
};

// The judgement boundary — one call per changed page. Unconfigured means the pass is a no-op.
struct Curator {
  virtual ~Curator() = default;
  virtual bool configured() const = 0;

  // Stamped on every echo row.
  virtual std::string version() const = 0;

  // `user` changes no judgement; it attributes the call's spend to an account.
  virtual Curation curate(const UserId& user, const std::vector<Vectored>& tonight,
                          const std::vector<Vectored>& candidates,
                          const std::vector<Pairing>& proposed) = 0;
};

}
