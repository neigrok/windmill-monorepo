#pragma once

#include "products/journal/domain/Passage.h"

#include <cstdint>
#include <string>
#include <vector>

namespace wm {

// A passage already stored for a day, reduced to what reconciliation needs.
struct KnownSpan {
  std::int64_t spanId = 0;
  std::string text;
};

// A freshly segmented passage with the identity it should keep. `spanId == 0` means the text is
// genuinely new and the caller mints one.
struct IdentifiedPassage {
  std::int64_t spanId = 0;
  Passage passage;
};

// Carry span identity across a re-derivation.
//
// This is the fix for the sharpest defect in the design: `(day, ord)` is a COORDINATE, not an
// identity. Insert one sentence at the top of a page and every ordinal shifts by one — which
// silently re-points every echo aimed at that page to its neighbouring sentence, and renders it
// confidently, because the wrong text still locates in the live body. It also resurrects dismissed
// echoes, which is the most trust-destroying thing this feature can do: the user told it to fade.
//
// So identity is the passage's normalised TEXT, never its position. A passage whose text is
// unchanged keeps its span_id however far it moved down the page; only genuinely new text mints.
// Duplicated text within one page is matched in document order, so two identical lines keep two
// stable, distinct identities rather than collapsing into one.
std::vector<IdentifiedPassage> reconcile(const std::vector<KnownSpan>& existing,
                                         const std::vector<Passage>& fresh);

}
