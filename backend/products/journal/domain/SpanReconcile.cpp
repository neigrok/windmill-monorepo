#include "products/journal/domain/SpanReconcile.h"

#include <cstddef>
#include <map>
#include <string>
#include <vector>

namespace wm {

std::vector<IdentifiedPassage> reconcile(const std::vector<KnownSpan>& existing,
                                         const std::vector<Passage>& fresh) {
  // Existing spans, bucketed by normalised text and kept in the order they were stored. Duplicated
  // text is the reason this is a queue per key rather than a single id: a page with two identical
  // lines must keep two distinct identities, matched in document order, or dismissing one would
  // dismiss the other.
  std::map<std::string, std::vector<std::int64_t>> available;
  for (const KnownSpan& known : existing)
    available[normalizedForIdentity(known.text)].push_back(known.spanId);

  std::vector<IdentifiedPassage> carried;
  carried.reserve(fresh.size());
  for (const Passage& passage : fresh) {
    const std::string key = normalizedForIdentity(passage.text);
    auto found = available.find(key);
    if (found == available.end() || found->second.empty()) {
      carried.push_back(IdentifiedPassage{0, passage});   // genuinely new text; the caller mints
      continue;
    }
    // Take the oldest unclaimed id for this text, so repeated re-derivations of an unchanged page
    // are stable rather than shuffling ids between identical lines.
    const std::int64_t claimed = found->second.front();
    found->second.erase(found->second.begin());
    carried.push_back(IdentifiedPassage{claimed, passage});
  }
  return carried;
}

}
