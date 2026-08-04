#pragma once

#include "products/journal/domain/EchoSelection.h"

#include <cstdint>
#include <string>
#include <vector>

namespace wm {

// What the curator decides about one proposed pairing. It writes no copy and asserts nothing about
// the user. It settles exactly two things a cosine cannot:
//
//   `related`       — do these two passages share a SUBJECT, or merely vocabulary? ("i like c++"
//                     against "i like the work" is the shape it exists to reject.) It also rejects
//                     a pairing about someone else's life — "Sam's dad died on Tuesday" is not an
//                     echo of "Dad's scan came back clear", however close the vectors sit.
//   `speakerIsSelf` — is the older passage the writer's own voice, or something they copied down?
//                     A pasted message, a lyric, a line said in session. These are verbatim page
//                     text and locate perfectly, so nothing else in the pipeline can catch them,
//                     and surfacing one under "you wrote this" is a false attribution.
struct Verdict {
  std::int64_t triggerSpanId = 0;
  std::int64_t matchSpanId = 0;
  bool related = false;
  float relation = 0.0f;       // comparative WITHIN this call only — never compared across calls,
                               // because each call mints its own private scale
  bool speakerIsSelf = true;
};

// `ok` false means the CALL failed, which is not the same as finding nothing. A page whose curate
// failed must be retried on a later pass; a page that genuinely had no echoes is done. Storing
// those two as the same empty result loses the user's page forever to a transient blip at 02:14.
struct Curation {
  bool ok = false;
  std::string failure;         // transport | rate_limited | truncated | schema_invalid | refused
  std::vector<Verdict> verdicts;
};

// The judgement boundary — one call per changed page. Unconfigured means the whole pass is a quiet
// no-op, the same discipline the shipped sweep already uses for its embedder.
struct Curator {
  virtual ~Curator() = default;
  virtual bool configured() const = 0;

  // Stamped on every echo row. A persisted, navigable graph accumulates rows judged by different
  // model and prompt versions over years; without this, a mixed-vintage chain is not debuggable
  // and cannot be selectively rebuilt.
  virtual std::string version() const = 0;

  virtual Curation curate(const std::vector<Vectored>& tonight,
                          const std::vector<Vectored>& candidates,
                          const std::vector<Pairing>& proposed) = 0;
};

}
