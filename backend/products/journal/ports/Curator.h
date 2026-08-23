#pragma once

#include "platform/domain/Ids.h"
#include "products/journal/domain/EchoSelection.h"

#include <cstdint>
#include <string>
#include <vector>

namespace wm {

// `speakerIsSelf`: the older passage is the writer's own voice, not something copied down.
struct Verdict {
  std::int64_t triggerSpanId = 0;
  std::int64_t matchSpanId = 0;
  bool related = false;
  // Absolute scale the curator prompt defines: 0.9+ the same specific thing, 0.6-0.8 that thing
  // seen later, 0.3-0.5 the same theme.
  float relation = 0.0f;
  bool speakerIsSelf = true;
};

// `ok` false means the call failed, not that nothing was found: retry the page.
struct Curation {
  bool ok = false;
  std::string failure;         // transport | rate_limited | truncated | schema_invalid | refused
  std::vector<Verdict> verdicts;
};

// One call per changed page. Unconfigured means the pass is a no-op.
struct Curator {
  virtual ~Curator() = default;
  virtual bool configured() const = 0;

  // Stamped on every echo row.
  virtual std::string version() const = 0;

  // `user` attributes the call's spend to an account.
  virtual Curation curate(const UserId& user, const std::vector<Vectored>& tonight,
                          const std::vector<Vectored>& candidates,
                          const std::vector<Pairing>& proposed) = 0;
};

}
