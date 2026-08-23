#include "products/journal/domain/SpanReconcile.h"

#include <cstddef>
#include <map>
#include <string>
#include <vector>

namespace wm {

std::vector<IdentifiedPassage> reconcile(const std::vector<KnownSpan>& existing,
                                         const std::vector<Passage>& fresh) {
  // A queue per key: two identical lines keep two identities, matched in document order.
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
    const std::int64_t claimed = found->second.front();
    found->second.erase(found->second.begin());
    carried.push_back(IdentifiedPassage{claimed, passage});
  }
  return carried;
}

}
