#pragma once

#include "products/journal/domain/Passage.h"

#include <cstdint>
#include <string>
#include <vector>

namespace wm {

struct KnownSpan {
  std::int64_t spanId = 0;
  std::string text;
};

// `spanId == 0` means the text is new and the caller mints one.
struct IdentifiedPassage {
  std::int64_t spanId = 0;
  Passage passage;
};

// Carry span identity across a re-derivation. Identity is the passage's normalised text, never its
// position: unchanged text keeps its span_id however far it moved, and only new text mints.
// Duplicated text within one page is matched in document order.
std::vector<IdentifiedPassage> reconcile(const std::vector<KnownSpan>& existing,
                                         const std::vector<Passage>& fresh);

}
