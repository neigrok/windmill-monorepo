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

// The atom grammar below, stamped by hand and bumped when a cut moves. A segmenter folds this into
// its `version()`, because a page is re-cut only when the stored version differs: a grid that cuts
// differently and stamps nothing reaches the pages written after it and leaves the archive as the
// old grid left it.
inline constexpr const char* kAtomGrammarVersion = "atoms.v3";

// Past this many words an atom is a breath rather than a thought — long enough to carry three
// topics into one embedding, which then matches none of them. The grammar cuts such a run at commas
// as its last resort, and a page that is STILL one atom this long is the page most worth showing a
// segmenter.
inline constexpr int kLongAtomWords = 25;

// WHAT A UNIT MAY WEIGH, and it is a bound on the embedder rather than on the writer. The sidecar
// reads 512 tokenizer pieces and REFUSES anything longer rather than silently truncating it — which
// is right, and would otherwise be a permanent paid loop: a refused batch fails the page, the page
// stays owed, and every six hours it is cut again by a vendor and refused again by the sidecar,
// forever. Measured on the writer this exists for: Russian runs ~5.6 pieces per word (894 characters
// = 728 pieces), so 80 words is ~450 pieces with the margin an inflected language deserves. A unit
// over it is split on its own atom boundaries, which is a worse cut than the model asked for and an
// immeasurably better one than a page that can never be embedded.
inline constexpr int kMaxUnitWords = 80;

struct SegmentRules {
  int minWords = 6;       // shorter than this merges into its neighbour
  int maxAtoms = 3;       // atoms joined into one passage, counted after the fragments merged
};

// Line breaks are hard boundaries, then the atom grammar within a line, then merge anything under
// `minWords` into its neighbour and join up to `maxAtoms` of what survives. Every returned [lo, hi)
// indexes back into `body` exactly.
std::vector<Passage> segment(const std::string& body, const SegmentRules& rules = {});

// Outer whitespace trimmed, internal runs collapsed to one space. Two passages with the same
// normalised text are the same passage for reconciliation and dismissal.
std::string normalizedForIdentity(const std::string& text);

// Whitespace-separated runs, which is the unit `kLongAtomWords` is measured in. Exposed so a caller
// asking "is there anything here to decide?" counts a page the same way the grammar does.
int wordsIn(const std::string& text);

// The verbatim check: each proposed unit is located in `body`, and the returned Passage carries the
// body's bytes, not the caller's. The scan runs forward — a unit is looked for at or after the end
// of the last one, then from the start once, then discarded. A whitespace run in the unit matches a
// whitespace run in the body; every other byte must match exactly, case included.
std::vector<Passage> locateUnits(const std::string& body, const std::vector<std::string>& units);

// ATOMS: the page cut as finely as this file goes, nothing merged into anything. Not the unit of
// retrieval; the unit of DECISION. A segmenter is shown these numbered and answers with indices, so
// the model chooses where thoughts begin and never touches a byte of what the writer wrote.
//
// The grammar, in the order a byte is tested: a line break; a `+ - – — •` opening a mid-line list
// item, which in Russian also covers the whitespace-wrapped dash that joins clauses where English
// uses a comma; a run of `.` `!` `?` `…`; `;` or `:` before whitespace; then, only inside an atom
// still longer than `kLongAtomWords`, a comma with three words standing on either side of it; and
// last of all, in an atom still over `kMaxUnitWords`, whitespace — a cut nobody wrote, which exists
// only because a unit the embedder cannot read is a page that can never be stored.
//
// Cutting too finely is free and cutting too coarsely is not: a segmenter can always answer
// starts=[1] and put the pieces back, so a finer grid strictly dominates a coarser one and costs
// only input tokens, the cheap half of the bill. A boundary this grammar never draws is one no
// segmenter can ask for, at any price.
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
//
// The one answer this cannot repair is no answer: an empty `starts` opens at atom 1 and settles
// the page as a single unit, byte-identical to a deliberate `{"starts":[1]}`. A caller that can
// tell the difference — one that knows the page had boundaries — refuses it before calling here.
struct Grouping {
  std::vector<Passage> units;
  int dropped = 0;
};

Grouping unitsFrom(const std::string& body, const std::vector<Passage>& atoms,
                   const std::vector<int>& starts);

}
