#pragma once

#include "platform/domain/Billing.h"
#include "platform/ports/SubscriptionRepository.h"
#include "products/journal/ports/EchoRepository.h"
#include "products/journal/ports/Embedder.h"
#include "products/journal/ports/JournalRepository.h"
#include "products/journal/ports/NudgeRepository.h"
#include "products/journal/ports/Transcriber.h"

#include <algorithm>
#include <cctype>
#include <cmath>
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

// A deterministic stand-in for the server-side embedding model: normalised per-letter counts over
// the 26 lowercase letters. Same text embeds to the same vector (cosine 1), text sharing most of its
// letters cosines close, and text over a disjoint set cosines low — enough for the echo sweep to
// tell a resonant pair from an unrelated one with no model in sight. `configured` is a settable flag
// so a test can exercise the "no embedder — the whole pass is a no-op" path.
struct FakeEmbedder : Embedder {
  bool isConfigured = true;

  bool configured() const override { return isConfigured; }
  std::vector<float> embed(const std::string& body) override {
    std::vector<float> counts(26, 0.0f);
    for (char raw : body) {
      const char c = static_cast<char>(std::tolower(static_cast<unsigned char>(raw)));
      if (c >= 'a' && c <= 'z') counts[c - 'a'] += 1.0f;
    }
    double norm = 0.0;
    for (float v : counts) norm += static_cast<double>(v) * v;
    if (norm == 0.0) return counts;   // an empty/letterless body has no direction; leave it zero
    for (float& v : counts) v = static_cast<float>(v / std::sqrt(norm));
    return counts;
  }
};

// An in-memory EchoRepository the sweep's tests drive by hand. The reads (activeSince, triggersSince)
// ignore their window and return what the test planted — the sweep's windowing is the real adapter's
// job, not the fake's — while the writes (saveVector, saveEcho) are RECORDED so a test asserts what
// the pass did. A saved vector also joins the corpus, exactly as the real corpusOf would see it on
// the next read, so "embed a missing vector, then match against it" works end to end.
class FakeEchoRepository : public EchoRepository {
public:
  struct SavedVector {
    UserId user;
    LocalDate day;
    std::vector<float> vector;
    std::uint64_t stampMs;
  };
  struct SavedEcho {
    UserId user;
    LocalDate triggerDay;
    EchoMatch match;
  };

  std::vector<EchoUser> users;                                // activeSince returns these, in order
  std::map<std::string, std::vector<PageText>> needing;      // user -> pages still needing a vector
  std::map<std::string, std::vector<EchoCandidate>> corpus;  // user -> already-vectored pages
  std::map<std::string, std::vector<LocalDate>> triggers;    // user -> recently-changed days
  std::vector<SavedVector> savedVectors;
  std::vector<SavedEcho> savedEchoes;

  void addUser(const UserId& user, const Email& email) { users.push_back(EchoUser{user, email}); }
  void addPageNeedingVector(const UserId& user, const LocalDate& day, const std::string& body,
                            std::uint64_t stampMs) {
    needing[user.str()].push_back(PageText{day, body, stampMs});
  }
  void addCorpusEntry(const UserId& user, const LocalDate& day, const std::vector<float>& vector,
                      const std::string& body) {
    corpus[user.str()].push_back(EchoCandidate{day, vector, body});
  }
  void addTrigger(const UserId& user, const LocalDate& day) { triggers[user.str()].push_back(day); }

  std::vector<EchoUser> activeSince(std::uint64_t) override { return users; }
  std::vector<PageText> pagesNeedingVector(const UserId& user) override {
    auto it = needing.find(user.str());
    if (it == needing.end()) return {};
    return it->second;
  }
  void saveVector(const UserId& user, const LocalDate& day, const std::vector<float>& vector,
                  std::uint64_t bodyStampMs) override {
    savedVectors.push_back(SavedVector{user, day, vector, bodyStampMs});
    corpus[user.str()].push_back(EchoCandidate{day, vector, ""});   // now visible to corpusOf
    auto it = needing.find(user.str());
    if (it == needing.end()) return;
    it->second.erase(std::remove_if(it->second.begin(), it->second.end(),
                                    [&](const PageText& p) { return p.day == day; }),
                     it->second.end());
  }
  std::vector<EchoCandidate> corpusOf(const UserId& user) override {
    auto it = corpus.find(user.str());
    if (it == corpus.end()) return {};
    return it->second;
  }
  std::vector<LocalDate> triggersSince(const UserId& user, std::uint64_t) override {
    auto it = triggers.find(user.str());
    if (it == triggers.end()) return {};
    return it->second;
  }
  void saveEcho(const UserId& user, const LocalDate& triggerDay, const EchoMatch& match) override {
    savedEchoes.push_back(SavedEcho{user, triggerDay, match});
  }

  std::vector<StoredEcho> echoesFor(const UserId& user, const LocalDate& from,
                                    const LocalDate& to) override {
    std::vector<StoredEcho> out;
    for (const SavedEcho& e : savedEchoes) {
      if (!(e.user == user)) continue;
      if (e.triggerDay < from || to < e.triggerDay) continue;
      out.push_back(StoredEcho{e.triggerDay, e.match.matchDay, e.match.triggerSpan, e.match.matchSpan,
                               e.match.score});
    }
    return out;
  }
  void dismiss(const UserId& user, const LocalDate& triggerDay) override {
    savedEchoes.erase(std::remove_if(savedEchoes.begin(), savedEchoes.end(),
                                     [&](const SavedEcho& e) {
                                       return e.user == user && e.triggerDay == triggerDay;
                                     }),
                      savedEchoes.end());
  }
};

// The billing mirror the echo sweep reads to tell a subscriber from everyone else. A user with no
// row is unsubscribed; one who has subscribed carries a live `active` status, the same predicate
// (grantsAccess) production reads. Mirrors TendingServiceTest's fake, minted email-agnostic.
struct FakeSubscriptionRepository : SubscriptionRepository {
  std::map<std::string, PaddleSubscription> byUser;

  void upsertCustomer(const PaddleCustomer&) override {}
  void upsertSubscription(const PaddleSubscription& subscription) override {
    byUser[subscription.userId] = subscription;
  }
  std::optional<PaddleSubscription> findFor(const UserId& user, const std::string&) override {
    auto it = byUser.find(user.str());
    if (it == byUser.end()) return std::nullopt;
    return it->second;
  }
  void subscribe(const UserId& user) {
    PaddleSubscription subscription;
    subscription.userId = user.str();
    subscription.status = "active";
    byUser[user.str()] = subscription;
  }
};

// A transcriber the voice tests drive: `on` toggles configured() (the 503 path), and transcribe
// returns a fixed line plus the last audio/mime it saw, so a test can assert the bytes reached it.
struct FakeTranscriber : Transcriber {
  bool on = true;
  std::string reply = "rain all morning";
  std::string lastAudio;
  std::string lastMime;

  bool configured() const override { return on; }
  Transcript transcribe(const std::string& audio, const std::string& mimeType) override {
    lastAudio = audio;
    lastMime = mimeType;
    return Transcript{reply};
  }
};

}
