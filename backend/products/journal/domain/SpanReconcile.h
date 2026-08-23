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

// Carry span identity across a re-derivation. Identity is the passage's normalised TEXT, never its
// position — `(day, ord)` is a coordinate, and one inserted sentence would re-point every echo
// aimed at the page and resurrect dismissed ones. A passage whose text is unchanged keeps its
// span_id however far it moved down the page; only genuinely new text mints. Duplicated text
// within one page is matched in document order.
std::vector<IdentifiedPassage> reconcile(const std::vector<KnownSpan>& existing,
                                         const std::vector<Passage>& fresh);

}
