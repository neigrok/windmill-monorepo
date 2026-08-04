#pragma once

#include <string>
#include <vector>

namespace wm {

// One segmented passage of a page — the retrieval unit echoes are built from. `lo`/`hi` are BYTE
// offsets into the page body and never leave the server: the client re-locates by `text`, because
// C++ counts bytes and JavaScript's slice counts UTF-16 code units, and the two diverge on the
// first non-ASCII character in a page. `text` is what survives an edit, so it — not the ordinal —
// is the identity the whole pipeline keys on.
struct Passage {
  int ord = 0;
  int lo = 0;
  int hi = 0;
  std::string text;
};

struct SegmentRules {
  int minWords = 6;       // shorter than this merges into its neighbour — fragments are attractors,
                          // matching everything and meaning nothing
  int maxSentences = 3;
};

// Line breaks are HARD boundaries, then sentence-split within a line, then merge anything under
// `minWords` into its neighbour. The line-break rule is load-bearing: a large share of nightly
// journalers write bare lists with no terminal punctuation, and sentence-splitting alone turns
// three unrelated items into one passage whose vector means nothing.
//
// Pure and total. The same body always yields the same passages, and every returned [lo, hi)
// indexes back into `body` exactly — `body.substr(lo, hi - lo)` is the passage as written, before
// normalisation.
std::vector<Passage> segment(const std::string& body, const SegmentRules& rules = {});

// The passage text reduced to its identity: outer whitespace trimmed, internal whitespace runs
// collapsed to one space. Two passages with the same normalised text are the same passage for
// reconciliation (carrying a span_id forward across an edit) and for dismissal (which is keyed on
// content, so that inserting a sentence at the top of a page cannot resurrect a dismissed echo).
std::string normalizedForIdentity(const std::string& text);

}
