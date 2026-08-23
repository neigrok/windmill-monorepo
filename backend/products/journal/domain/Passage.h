#pragma once

#include <string>
#include <vector>

namespace wm {

// One segmented passage of a page — the retrieval unit echoes are built from. `lo`/`hi` are BYTE
// offsets into the page body and never leave the server: the client re-locates by `text`, because
// C++ counts bytes and JavaScript's slice counts UTF-16 code units. `text`, not the ordinal, is the
// identity the whole pipeline keys on.
struct Passage {
  int ord = 0;
  int lo = 0;
  int hi = 0;
  std::string text;
};

struct SegmentRules {
  int minWords = 6;       // shorter than this merges into its neighbour
  int maxSentences = 3;
};

// Line breaks are HARD boundaries, then sentence-split within a line, then merge anything under
// `minWords` into its neighbour.
//
// Pure and total. The same body always yields the same passages, and every returned [lo, hi)
// indexes back into `body` exactly — `body.substr(lo, hi - lo)` is the passage as written, before
// normalisation.
std::vector<Passage> segment(const std::string& body, const SegmentRules& rules = {});

// The passage text reduced to its identity: outer whitespace trimmed, internal whitespace runs
// collapsed to one space. Two passages with the same normalised text are the same passage for
// reconciliation and for dismissal.
std::string normalizedForIdentity(const std::string& text);

// The verbatim check. `units` are lines a segmenter proposes; each is located in `body` and kept
// only if it is genuinely there, and the returned Passage carries the BODY's bytes, not the
// model's, so a corrected, translated or re-punctuated unit is discarded rather than shown to the
// writer as their own sentence.
//
// The scan runs FORWARD: each unit is looked for at or after the end of the last one, so a page
// that says the same sentence twice gives its two units two different places. A unit not found
// from there is looked for from the start once, then discarded.
//
// Whitespace is the one difference tolerated: a run of whitespace in the unit matches a run of
// whitespace in the body. Every other byte must match exactly, case included.
std::vector<Passage> locateUnits(const std::string& body, const std::vector<std::string>& units);

}
