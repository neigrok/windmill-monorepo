#pragma once

#include "products/journal/ports/JournalRepository.h"
#include "products/journal/ports/NudgeRepository.h"

#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
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

// An in-memory NudgeRepository the sweep's tests drive by hand. It records what it was asked in the
// order it was asked — DECIDE → CLAIM → SEND is an ordering guarantee, so a test asserts the order
// as well as the outcome. claimDay is the whole mutex: the ledger row IS the primary key, and a
// claim clears next_due_at so the served instant can never fire twice. The sweep lock is a no-op
// (correctness rides on the claim, never on it).
class FakeNudgeRepository : public NudgeRepository {
public:
  struct Claim {
    UserId user;
    LocalDate slotDay;
    NudgeDecision decision;
  };
  struct Close {
    UserId user;
    LocalDate slotDay;
    DayOutcome outcome;
  };

  std::map<std::string, Email> emails;             // user -> the address a due send goes to
  std::map<std::string, NudgeSettings> settings;   // user -> the whole owned row
  std::set<std::string> wrote;                     // "user|day-iso" the test populates
  std::set<std::string> ledger;                    // "user|day-iso" rows a claim already owns
  std::vector<Claim> claims;
  std::vector<Close> closes;
  std::map<std::string, std::string> pauseDigests; // user -> latest pause digest

  static std::string dayKey(const UserId& user, const LocalDate& day) {
    return user.str() + "|" + day.iso();
  }

  // Arm one user the sweep will find due: an address to send to and an enabled, device-materialised
  // schedule whose instant has already arrived (that instant doubles as slotInstantMs). Tweak the
  // stored settings — pause(), disable(), or the exposed map — for the paused/suppressed variants.
  void armDue(const UserId& user, const Email& email, const LocalDate& slotDay,
              std::uint64_t instantMs) {
    emails[user.str()] = email;
    NudgeSettings row;
    row.enabled = true;
    row.channel = "email";
    row.nextDueAtMs = instantMs;
    row.slotDay = slotDay;
    settings[user.str()] = row;
  }
  void markWrote(const UserId& user, const LocalDate& day) { wrote.insert(dayKey(user, day)); }

  bool tryLockSweep() override { return true; }
  void unlockSweep() override {}

  std::vector<NudgeDueUser> dueNow(std::uint64_t nowMs, int limit) override {
    std::vector<NudgeDueUser> out;
    for (const auto& [user, row] : settings) {
      if (!row.enabled || row.suppressed) continue;
      if (!row.nextDueAtMs || *row.nextDueAtMs > nowMs) continue;   // never / not yet
      if (!row.slotDay) continue;   // a due row with no local day is unsendable — never a candidate
      auto e = emails.find(user);
      out.push_back(NudgeDueUser{UserId{user}, e == emails.end() ? Email{} : e->second, *row.slotDay,
                            *row.nextDueAtMs, row.pausedUntilMs.value_or(0)});
      if (static_cast<int>(out.size()) >= limit) break;
    }
    return out;
  }
  bool wroteToday(const UserId& user, const LocalDate& day) override {
    return wrote.count(dayKey(user, day)) > 0;
  }

  bool claimDay(const UserId& user, const LocalDate& slotDay,
                const NudgeDecision& decision) override {
    if (ledger.count(dayKey(user, slotDay))) return false;   // a row already owns this day
    auto it = settings.find(user.str());
    if (it == settings.end() || !it->second.enabled || it->second.suppressed) return false;
    ledger.insert(dayKey(user, slotDay));
    claims.push_back(Claim{user, slotDay, decision});
    it->second.nextDueAtMs.reset();   // the served instant can never fire twice
    return true;
  }
  void closeDay(const UserId& user, const LocalDate& slotDay, DayOutcome outcome) override {
    closes.push_back(Close{user, slotDay, outcome});
  }

  std::optional<NudgeSettings> settingsFor(const UserId& user) override {
    auto it = settings.find(user.str());
    if (it == settings.end()) return std::nullopt;
    return it->second;
  }
  void upsertSettings(const UserId& user, const NudgeSettings& row) override {
    settings[user.str()] = row;
  }

  void setPauseDigest(const UserId& user, const std::string& digest) override {
    pauseDigests[user.str()] = digest;
  }
  std::optional<UserId> userByPauseDigest(const std::string& digest) override {
    if (digest.empty()) return std::nullopt;
    for (const auto& [user, stored] : pauseDigests)
      if (stored == digest) return UserId{user};
    return std::nullopt;
  }
  void pause(const UserId& user, std::uint64_t untilMs) override {
    settings[user.str()].pausedUntilMs = untilMs;
  }
  void disable(const UserId& user) override { settings[user.str()].enabled = false; }
};

}
