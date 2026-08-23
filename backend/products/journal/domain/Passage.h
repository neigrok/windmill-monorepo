#pragma once

#include <string>
#include <vector>

namespace wm {

// `lo`/`hi` are byte offsets into the page body and never leave the server; the client re-locates
// by `text`, which is the identity the pipeline keys on rather than the ordinal.
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

// Line breaks are hard boundaries, then sentence-split within a line, then merge anything under
// `minWords` into its neighbour. Every returned [lo, hi) indexes back into `body` exactly.
std::vector<Passage> segment(const std::string& body, const SegmentRules& rules = {});

// Outer whitespace trimmed, internal runs collapsed to one space. Two passages with the same
// normalised text are the same passage for reconciliation and dismissal.
std::string normalizedForIdentity(const std::string& text);

// The verbatim check: each proposed unit is located in `body`, and the returned Passage carries the
// body's bytes, not the caller's. The scan runs forward — a unit is looked for at or after the end
// of the last one, then from the start once, then discarded. A whitespace run in the unit matches a
// whitespace run in the body; every other byte must match exactly, case included.
std::vector<Passage> locateUnits(const std::string& body, const std::vector<std::string>& units);

// ATOMS: the page cut as finely as this file goes — line breaks are hard boundaries, then one
// sentence each, nothing merged into anything. Not the unit of retrieval; the unit of DECISION. A
// segmenter is shown these numbered and answers with indices, so the model chooses where thoughts
// begin and never touches a byte of what the writer wrote.
std::vector<Passage> atomsOf(const std::string& body);

// One page's atoms grouped into idea units. `starts` are 1-based atom numbers at which a new unit
// begins, as a segmenter named them; units are contiguous runs, so every atom belongs to exactly one
// and the units tile the page.
//
// The answer is REPAIRED rather than refused: out of range, out of order, duplicated, or missing the
// opening 1 are all fixed deterministically, and `dropped` counts what could not be used. This is
// safe in a way that trusting returned TEXT never was — any partition of atoms is made of the body's
// own bytes, so the worst a confused answer can do is group thoughts badly, never misquote the
// writer. Refusing the page instead would trade a real echo for a cosmetic failure.
struct Grouping {
  std::vector<Passage> units;
  int dropped = 0;
};

Grouping unitsFrom(const std::string& body, const std::vector<Passage>& atoms,
                   const std::vector<int>& starts);

}
