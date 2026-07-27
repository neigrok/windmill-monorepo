#pragma once

#include "products/journal/domain/Page.h"

#include <optional>
#include <utility>
#include <string>
#include <vector>

namespace wm {

// One page's server-side embedding, ready to compare. `day` locates it in time (so the finder can
// insist a match is genuinely OLDER), `vector` is the embedding of `body`, and `body` carries the
// text the returned span points into.
struct EchoCandidate {
  LocalDate day;
  std::vector<float> vector;
  std::string body;
};

// An echo: today's page (the trigger) resonates with an older one. Spans are half-open char ranges
// [lo, hi) into each page's body; score is cosine similarity in [0, 1], stored but surfaced only as
// presence — never a number the reader sees.
struct EchoMatch {
  LocalDate matchDay;
  std::pair<int, int> triggerSpan;
  std::pair<int, int> matchSpan;
  float score = 0.0f;
};

struct EchoRules {
  float threshold = 0.62f;   // below this, today simply does not echo anything
  int minDayGap = 14;        // an echo reaches back; yesterday is never one
};

// The one interesting calc, kept pure and dependency-light: cosine the trigger against every
// candidate at least `minDayGap` days OLDER, return the single best above `threshold` (the canon
// shows one "you said it before") or nullopt. Page-level for now — each span is the whole page — so
// the vectors arrive already computed and a test can hand-craft them with no embedder in sight.
std::optional<EchoMatch> match(const EchoCandidate& trigger,
                               const std::vector<EchoCandidate>& corpus, const EchoRules& rules);

}
