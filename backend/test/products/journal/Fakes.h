#pragma once

#include "products/journal/ports/JournalRepository.h"

#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace wm::fake {

inline UserId uid(std::string value = "u1") { return UserId{std::move(value)}; }
inline LocalDate ld(std::string iso) { return LocalDate{std::move(iso)}; }
inline Hlc hlc(std::uint64_t ms, std::uint32_t counter = 0, std::string actor = "dev") {
  return Hlc{ms, counter, std::move(actor)};
}

// An in-memory JournalRepository that applies the SAME last-writer-wins rule as the SQL upsert:
// an incoming write wins only if its stamp is STRICTLY greater than the stored one (ties keep the
// stored row, exactly like the adapter's `EXCLUDED.stamp > stored.stamp`). Convergence tests assert
// against this so the fake and the real adapter can never quietly disagree about who wins.
class FakeJournalRepository : public JournalRepository {
public:
  using Key = std::pair<std::string, std::string>;   // (user, day-iso)
  std::map<Key, Page> byKey;

  static Key key(const UserId& user, const LocalDate& day) { return {user.str(), day.iso()}; }

  std::optional<Page> load(const UserId& user, const LocalDate& day) override {
    auto it = byKey.find(key(user, day));
    if (it == byKey.end()) return std::nullopt;
    return it->second;
  }

  std::vector<Page> range(const UserId& user, const LocalDate& from, const LocalDate& to) override {
    std::vector<Page> out;
    for (const auto& [k, page] : byKey)
      if (k.first == user.str() && !(page.day < from) && !(to < page.day)) out.push_back(page);
    std::sort(out.begin(), out.end(), [](const Page& a, const Page& b) { return a.day < b.day; });
    return out;
  }

  std::vector<Page> since(const UserId& user, const Hlc& cursor, int limit) override {
    std::vector<Page> out;
    for (const auto& [k, page] : byKey)
      if (k.first == user.str() && cursor < page.stamp) out.push_back(page);
    std::sort(out.begin(), out.end(), [](const Page& a, const Page& b) { return a.stamp < b.stamp; });
    // Page is not default-constructible (LocalDate has only an explicit ctor), so resize() won't
    // compile — erase the tail instead; the branch only ever shrinks, so no default is needed.
    if (static_cast<int>(out.size()) > limit) out.erase(out.begin() + limit, out.end());
    return out;
  }

  std::vector<Page> all(const UserId& user) override {
    std::vector<Page> out;
    for (const auto& [k, page] : byKey)
      if (k.first == user.str()) out.push_back(page);
    std::sort(out.begin(), out.end(), [](const Page& a, const Page& b) { return a.day < b.day; });
    return out;
  }

  PageWrite save(const Page& incoming) override {
    auto k = key(incoming.user, incoming.day);
    auto it = byKey.find(k);
    if (it == byKey.end()) {
      byKey.emplace(k, incoming);
      return PageWrite::stored;
    }
    if (!(it->second.stamp < incoming.stamp)) return PageWrite::ignoredStale;   // stored wins ties
    it->second = incoming;
    return PageWrite::superseded;
  }
};

}
