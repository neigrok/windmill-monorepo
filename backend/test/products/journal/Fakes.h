#pragma once

#include "products/journal/ports/Curator.h"
#include "products/journal/ports/EchoRepository.h"
#include "products/journal/ports/Embedder.h"
#include "products/journal/ports/JournalRepository.h"
#include "products/journal/ports/Segmenter.h"
#include "products/journal/ports/NudgeMailSender.h"
#include "products/journal/ports/NudgeRepository.h"
#include "products/journal/ports/Transcriber.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wm::fake {

inline UserId uid(std::string value = "u1") { return UserId{std::move(value)}; }
inline LocalDate ld(std::string iso) { return LocalDate{std::move(iso)}; }
inline Hlc hlc(std::uint64_t ms, std::uint32_t counter = 0, std::string actor = "dev") {
  return Hlc{ms, counter, std::move(actor)};
}

// Applies the same last-writer-wins rule as the SQL upsert: an incoming write wins only on a strictly greater stamp.
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
    // Page is not default-constructible, so resize() won't compile — erase the tail instead.
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

// Records what it was asked in order: DECIDE → CLAIM → SEND. claimDay is the whole mutex — the ledger row IS the primary key, and a claim clears next_due_at so the served instant can never fire twice.
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
  std::set<std::string> unreadable;                // users whose load throws
  std::vector<Claim> claims;
  std::vector<Close> closes;
  std::map<std::string, std::string> pauseDigests; // user -> latest pause digest

  static std::string dayKey(const UserId& user, const LocalDate& day) {
    return user.str() + "|" + day.iso();
  }

  // Arm one user the sweep will find due: an address plus an enabled schedule whose instant has already arrived (that instant doubles as slotInstantMs).
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

  bool underSweepLock(const std::function<void()>& pass) override {
    pass();
    return true;
  }

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
    if (unreadable.count(user.str())) throw std::runtime_error("journal_pages is on fire");
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
    // The real one writes every column BUT `suppressed`: only liftSuppression clears the provider's verdict.
    const bool suppressed = settings[user.str()].suppressed;
    settings[user.str()] = row;
    settings[user.str()].suppressed = suppressed;
  }

  // Keyed by address like the real one. An address nobody owns writes nothing and answers false; the row is created when missing.
  bool stopMailing(const Email& address) override {
    for (const auto& [user, owned] : emails)
      if (owned.value == address.value) {
        settings[user].suppressed = true;
        return true;
      }
    return false;
  }
  // Like the real UPDATE it creates nothing, and `enabled` stays exactly as it was.
  void liftSuppression(const UserId& user) override {
    auto it = settings.find(user.str());
    if (it != settings.end()) it->second.suppressed = false;
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

// Async like the real sender but resolves inline; failNext makes the next send report false and record nothing.
struct FakeNudgeMail : NudgeMailSender {
  struct Sent {
    Email to;
    JournalNudgeMail mail;
  };
  std::vector<Sent> sent;
  bool failNext = false;

  void sendJournalNudge(const Email& to, const JournalNudgeMail& mail,
                        std::function<void(bool)> done) override {
    if (failNext) {
      failNext = false;
      done(false);
      return;
    }
    sent.push_back(Sent{to, mail});
    done(true);
  }
};

// Cuts a page by lines, then sentences; `units` overrides that.
struct FakeSegmenter : Segmenter {
  bool isConfigured = true;
  bool callSucceeds = true;
  std::string failure = "transport";
  std::vector<std::string> units;   // empty: fall back to the rule
  int calls = 0;

  bool configured() const override { return isConfigured; }
  std::string version() const override { return "fake-segmenter-v1"; }

  Segmentation unitsOf(const UserId&, const std::string& body) override {
    ++calls;
    Segmentation cut;
    if (!callSucceeds) {
      cut.failure = failure;
      return cut;
    }
    if (units.empty()) {
      cut.ok = true;
      cut.passages = segment(body);
      return cut;
    }
    cut.passages = locateUnits(body, units);
    cut.discarded = static_cast<int>(units.size()) - static_cast<int>(cut.passages.size());
    cut.ok = !cut.passages.empty();
    if (!cut.ok) cut.failure = "schema_invalid";
    return cut;
  }
};

struct FakeEmbedder : Embedder {
  bool isConfigured = true;
  bool failNext = false;

  bool configured() const override { return isConfigured; }
  std::string version() const override { return "fake-embedder-v1"; }

  std::vector<std::vector<float>> embed(const std::vector<std::string>& passages) override {
    if (failNext) return {};
    std::vector<std::vector<float>> out;
    out.reserve(passages.size());
    for (const std::string& body : passages) {
      std::vector<float> counts(26, 0.0f);
      for (char raw : body) {
        const char c = static_cast<char>(std::tolower(static_cast<unsigned char>(raw)));
        if (c >= 'a' && c <= 'z') counts[c - 'a'] += 1.0f;
      }
      double norm = 0.0;
      for (float v : counts) norm += static_cast<double>(v) * v;
      if (norm > 0.0)
        for (float& v : counts) v = static_cast<float>(v / std::sqrt(norm));
      out.push_back(counts);
    }
    return out;
  }
};

// Keeps or rejects every pairing wholesale, and can fail the CALL — which the sweep must treat differently from finding nothing.
struct FakeCurator : Curator {
  bool isConfigured = true;
  bool callSucceeds = true;
  std::string failure = "transport";
  bool keepEverything = true;
  bool speakerIsSelf = true;
  int calls = 0;
  std::vector<UserId> billed;   // whose night each call was charged to, in order

  bool configured() const override { return isConfigured; }
  std::string version() const override { return "fake-curator-v1"; }

  Curation curate(const UserId& user, const std::vector<Vectored>&, const std::vector<Vectored>&,
                  const std::vector<Pairing>& proposed) override {
    ++calls;
    billed.push_back(user);
    Curation curation;
    curation.ok = callSucceeds;
    curation.failure = failure;
    if (!callSucceeds) return curation;
    for (const Pairing& pairing : proposed)
      curation.verdicts.push_back(Verdict{pairing.triggerSpanId, pairing.matchSpanId,
                                          keepEverything, 0.9f, speakerIsSelf});
    return curation;
  }
};

// Stores spans and echoes the way the real adapter does: replace-a-page-atomically, identities minted on demand.
class FakeEchoRepository : public EchoRepository {
public:
  struct StoredSpan {
    LocalDate day;
    SpanWrite write;
    std::string embedVersion;
  };

  // What the reader said about a pairing, with the score and the curator version it was judged under.
  struct StoredSignal {
    LocalDate triggerDay;
    std::int64_t triggerSpanId = 0;
    LocalDate matchDay;
    std::int64_t matchSpanId = 0;
    EchoSignal kind = EchoSignal::opened;
    float cosine = 0.0f;
    float relation = 0.0f;
    std::string curatorVersion;
  };

  std::vector<EchoUser> users;
  std::map<std::string, std::vector<DuePage>> due;
  std::map<std::string, std::string> bodies;   // "user|day" -> the page as it stands right now
  std::map<std::string, std::vector<StoredSpan>> spans;
  // Waved-away pairs keyed on the two passages' NORMALISED TEXT and scoped to one user, exactly as the SQL keys them on content hashes.
  std::map<std::string, std::set<std::pair<std::string, std::string>>> dismissals;
  std::set<std::string> offersRetired;   // "user|day" -> the reader answered "not now" here
  std::map<std::string, std::vector<StoredSignal>> signals;
  std::map<std::string, CuratedEchoes> echoesByPage;   // "user|day" -> what the pass wrote
  std::vector<CurationOutcome> outcomes;
  std::map<std::string, std::vector<LocalDate>> inbound;
  std::uint64_t stamp = 1;
  std::int64_t nextSpanId = 100;
  int corpusLoads = 0;   // how many times the whole corpus was actually read off storage

  static std::string pageKey(const UserId& user, const LocalDate& day) {
    return user.str() + "|" + day.iso();
  }

  void addUser(const UserId& user) { users.push_back(EchoUser{user}); }
  void plantPage(const UserId& user, const LocalDate& day, const std::string& body) {
    bodies[pageKey(user, day)] = body;
  }
  void addDuePage(const UserId& user, const LocalDate& day, const std::string& body) {
    due[user.str()].push_back(DuePage{day, body, stamp, 0});
    plantPage(user, day, body);
  }
  // Plant an already-derived page. `lo` is the passage's byte offset into the body, which is what tells two identical sentences apart.
  void plantSpan(const UserId& user, const LocalDate& day, std::int64_t spanId,
                 const std::string& text, const std::vector<float>& vector, int lo = 0) {
    spans[user.str()].push_back(
        StoredSpan{day,
                   SpanWrite{spanId, Passage{0, lo, lo + static_cast<int>(text.size()), text},
                             vector},
                   "fake-embedder-v1"});
  }

  std::vector<EchoUser> activeSince(std::uint64_t) override { return users; }
  std::uint64_t corpusStamp(const UserId&) override { return stamp; }

  // `staleVersions` is the switch a test flips to say the page was derived by a pipeline that has since moved — the SQL's IS DISTINCT FROM.
  std::vector<DuePage> duePages(const UserId& user, std::uint64_t,
                                const PipelineVersions&) override {
    auto it = due.find(user.str());
    if (it == due.end()) return {};
    return it->second;
  }

  // The one named row, the way the SQL asks it.
  std::optional<DuePage> duePage(const UserId& user, const LocalDate& day, std::uint64_t,
                                 const PipelineVersions&) override {
    auto it = due.find(user.str());
    if (it == due.end()) return std::nullopt;
    for (const DuePage& page : it->second)
      if (page.day == day) return page;
    return std::nullopt;
  }

  // Only a SETTLED pass calls this — a failure that clears leaves the page owed.
  void settle(const UserId& user, const LocalDate& day) {
    std::vector<DuePage>& pages = due[user.str()];
    pages.erase(std::remove_if(pages.begin(), pages.end(),
                               [&](const DuePage& page) { return page.day == day; }),
                pages.end());
  }

  // The page as it stands, whether or not anything is owed. `bodyMoved` false means the text is unchanged, so units are read back rather than bought again.
  std::optional<DuePage> pageAt(const UserId& user, const LocalDate& day) override {
    auto it = bodies.find(pageKey(user, day));
    if (it == bodies.end()) return std::nullopt;
    return DuePage{day, it->second, stamp, 0, false};
  }

  std::vector<KnownSpan> spansOf(const UserId& user, const LocalDate& day) override {
    std::vector<KnownSpan> known;
    auto it = spans.find(user.str());
    if (it == spans.end()) return known;
    for (const StoredSpan& stored : it->second)
      if (stored.day == day) known.push_back(KnownSpan{stored.write.spanId, stored.write.passage.text});
    return known;
  }

  std::vector<Vectored> replaceSpans(const UserId& user, const LocalDate& day,
                                     const std::vector<SpanWrite>& writes,
                                     const std::string& embedVersion, std::uint64_t) override {
    // The ORDER pages were worked in, whether or not a page proposed anything.
    derived.push_back(pageKey(user, day));
    std::vector<StoredSpan>& all = spans[user.str()];
    all.erase(std::remove_if(all.begin(), all.end(),
                             [&](const StoredSpan& s) { return s.day == day; }),
              all.end());
    std::vector<Vectored> stored;
    stored.reserve(writes.size());
    for (SpanWrite write : writes) {
      if (write.spanId == 0) write.spanId = nextSpanId++;
      all.push_back(StoredSpan{day, write, embedVersion});
      stored.push_back(Vectored{write.spanId, day, write.passage.text, write.vector});
    }
    return stored;
  }

  std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) override {
    ++corpusLoads;
    std::vector<Vectored> corpus;
    auto it = spans.find(user.str());
    if (it == spans.end()) return corpus;
    for (const StoredSpan& stored : it->second) {
      if (stored.embedVersion != embedVersion) continue;
      corpus.push_back(Vectored{stored.write.spanId, stored.day, stored.write.passage.text,
                                stored.write.vector});
    }
    // ORDER BY day, ord, like the SQL — the order is part of the port's contract.
    std::stable_sort(corpus.begin(), corpus.end(), [&](const Vectored& a, const Vectored& b) {
      if (!(a.day == b.day)) return a.day < b.day;
      const StoredSpan* left = spanOf(user, a.spanId);
      const StoredSpan* right = spanOf(user, b.spanId);
      return left && right && left->write.passage.ord < right->write.passage.ord;
    });
    return corpus;
  }

  // One span by identity, or nothing — the same INNER join the SQL does.
  const StoredSpan* spanOf(const UserId& user, std::int64_t spanId) const {
    auto it = spans.find(user.str());
    if (it == spans.end()) return nullptr;
    for (const StoredSpan& stored : it->second)
      if (stored.write.spanId == spanId) return &stored;
    return nullptr;
  }

  bool isDismissed(const UserId& user, const std::string& triggerText,
                   const std::string& matchText) const {
    auto it = dismissals.find(user.str());
    if (it == dismissals.end()) return false;
    return it->second.count({normalizedForIdentity(triggerText), normalizedForIdentity(matchText)});
  }

  std::vector<SpanPair> dismissalsOn(const UserId& user, const LocalDate& day) override {
    // Content in, identities out: every span carrying dismissed text is dismissed against every earlier span carrying its partner's text.
    std::vector<SpanPair> pairs;
    auto it = spans.find(user.str());
    if (it == spans.end()) return pairs;
    for (const StoredSpan& trigger : it->second) {
      if (!(trigger.day == day)) continue;
      for (const StoredSpan& match : it->second) {
        if (!(match.day < day)) continue;
        if (!isDismissed(user, trigger.write.passage.text, match.write.passage.text)) continue;
        pairs.push_back(SpanPair{trigger.write.spanId, match.write.spanId});
      }
    }
    return pairs;
  }

  // Content in, and only content: the same key the SQL writes.
  void plantDismissal(const UserId& user, std::int64_t triggerSpanId, std::int64_t matchSpanId) {
    const StoredSpan* trigger = spanOf(user, triggerSpanId);
    const StoredSpan* match = spanOf(user, matchSpanId);
    if (!trigger || !match) return;   // a passage that is already gone is already unshown
    dismissals[user.str()].insert({normalizedForIdentity(trigger->write.passage.text),
                                   normalizedForIdentity(match->write.passage.text)});
  }

  void dismissPair(const UserId& user, const LocalDate& triggerDay,
                   const LocalDate& matchDay) override {
    for (const EchoRow& row : rowsOn(user, triggerDay)) {
      if (!(row.matchDay == matchDay)) continue;
      plantDismissal(user, row.triggerSpanId, row.matchSpanId);
    }
  }

  void dismissPage(const UserId& user, const LocalDate& triggerDay) override {
    for (const EchoRow& row : rowsOn(user, triggerDay))
      plantDismissal(user, row.triggerSpanId, row.matchSpanId);
  }

  // "Not now" lives in its own set and touches nothing else, exactly as the SQL keeps it.
  void dismissOffer(const UserId& user, const LocalDate& day) override {
    offersRetired.insert(pageKey(user, day));
  }

  // Signals store the retrieval score and the curator's version copied off the echo row, as the INSERT ... SELECT does.
  bool hasSignal(const UserId& user, std::int64_t triggerSpanId, std::int64_t matchSpanId,
                 EchoSignal kind) const {
    auto it = signals.find(user.str());
    if (it == signals.end()) return false;
    for (const StoredSignal& signal : it->second)
      if (signal.triggerSpanId == triggerSpanId && signal.matchSpanId == matchSpanId &&
          signal.kind == kind)
        return true;
    return false;
  }

  void recordSignal(const UserId& user, const LocalDate& triggerDay, const LocalDate& matchDay,
                    EchoSignal kind) override {
    auto it = echoesByPage.find(pageKey(user, triggerDay));
    if (it == echoesByPage.end()) return;
    for (const EchoRow& row : it->second.rows) {
      if (!(row.matchDay == matchDay)) continue;
      if (hasSignal(user, row.triggerSpanId, row.matchSpanId, kind)) continue;   // pressed twice
      signals[user.str()].push_back(StoredSignal{triggerDay, row.triggerSpanId, row.matchDay,
                                                 row.matchSpanId, kind, row.cosine, row.relation,
                                                 it->second.curatorVersion});
    }
  }

  void recordPageSignal(const UserId& user, const LocalDate& triggerDay, EchoSignal kind) override {
    auto it = echoesByPage.find(pageKey(user, triggerDay));
    if (it == echoesByPage.end()) return;
    for (const EchoRow& row : it->second.rows) recordSignal(user, triggerDay, row.matchDay, kind);
  }

  // ADDITIVE, exactly as the SQL is. This used to assign the new set over the old, which made the
  // fake more destructive than production and hid a real defect for as long as it existed: a
  // pairing the curator stopped returning vanished here and was permanent there. What goes is a
  // row whose spans are gone, or one this pass put to the curator again and was refused.
  void replaceEchoes(const UserId& user, const LocalDate& day,
                     const CuratedEchoes& curated) override {
    const auto lives = [&](std::int64_t spanId) {
      for (const StoredSpan& stored : spans[user.str()])
        if (stored.write.spanId == spanId) return true;
      return false;
    };
    const auto refused = [&](const EchoRow& row) {
      for (const SpanPair& pair : curated.refused)
        if (pair.triggerSpanId == row.triggerSpanId && pair.matchSpanId == row.matchSpanId)
          return true;
      return false;
    };

    CuratedEchoes kept;
    kept.curatorVersion = curated.curatorVersion;
    for (const EchoRow& row : echoesByPage[pageKey(user, day)].rows) {
      if (!lives(row.triggerSpanId) || !lives(row.matchSpanId) || refused(row)) continue;
      bool replaced = false;
      for (const EchoRow& fresh : curated.rows)
        if (fresh.triggerSpanId == row.triggerSpanId && fresh.matchSpanId == row.matchSpanId)
          replaced = true;
      if (!replaced) kept.rows.push_back(row);
    }
    for (const EchoRow& row : curated.rows) kept.rows.push_back(row);
    echoesByPage[pageKey(user, day)] = kept;
  }
  void clearEchoes(const UserId& user, const LocalDate& day) override {
    echoesByPage.erase(pageKey(user, day));
  }

  // A SETTLED pass advances the page's stamps; a failure that will clear on its own writes the error and leaves both stamps, so the page stays owed.
  void recordCuration(const UserId& user, const LocalDate& day,
                      const CurationOutcome& outcome) override {
    outcomes.push_back(outcome);
    if (isSettled(outcome.status)) settle(user, day);
  }

  std::vector<LocalDate> inboundPages(const UserId& user, const LocalDate& day) override {
    auto it = inbound.find(pageKey(user, day));
    if (it == inbound.end()) return {};
    return it->second;
  }

  // The reader's view as the SQL assembles it: both spans join INNER, dismissed pairs are gone, passages travel as text, and the anchoring hint is counted against the match page as it stands.
  std::vector<EchoView> echoesFor(const UserId& user, const LocalDate& from,
                                  const LocalDate& to) override {
    std::vector<EchoView> views;
    for (const auto& [key, page] : echoesByPage) {
      if (key.rfind(user.str() + "|", 0) != 0) continue;
      const LocalDate triggerDay{key.substr(user.str().size() + 1)};
      if (triggerDay < from || to < triggerDay) continue;
      for (const EchoRow& row : page.rows) {
        const StoredSpan* trigger = spanOf(user, row.triggerSpanId);
        const StoredSpan* match = spanOf(user, row.matchSpanId);
        if (!trigger || !match) continue;
        if (isDismissed(user, trigger->write.passage.text, match->write.passage.text)) continue;
        auto body = bodies.find(pageKey(user, row.matchDay));
        views.push_back(EchoView{
            triggerDay, row.triggerSpanId, trigger->write.passage.text, row.matchDay,
            row.matchSpanId, match->write.passage.text, row.matchIsSelf, Source::typed, 0,
            body == bodies.end()
                ? -1
                : occurrenceAt(body->second, match->write.passage.text, match->write.passage.lo),
            hasSignal(user, row.triggerSpanId, row.matchSpanId, EchoSignal::useful)});
      }
    }
    return views;
  }

  std::vector<LocalDate> retiredOffers(const UserId& user, const LocalDate& from,
                                       const LocalDate& to) override {
    std::vector<LocalDate> days;
    for (const std::string& key : offersRetired) {
      if (key.rfind(user.str() + "|", 0) != 0) continue;
      const LocalDate day{key.substr(user.str().size() + 1)};
      if (day < from || to < day) continue;
      days.push_back(day);
    }
    return days;
  }

  int pagesWritten(const UserId& user) override {
    int written = 0;
    for (const auto& [key, body] : bodies)
      if (key.rfind(user.str() + "|", 0) == 0 &&
          body.find_first_not_of(" \t\r\n") != std::string::npos)
        ++written;
    return written;
  }

  // Pages worked, oldest call first.
  std::vector<std::string> derived;

  std::vector<EchoRow> rowsOn(const UserId& user, const LocalDate& day) {
    auto it = echoesByPage.find(pageKey(user, day));
    if (it == echoesByPage.end()) return {};
    return it->second.rows;
  }
};

// `on` toggles configured() (the 503 path), `answers` toggles the vendor failure (the 502 path); `hold` keeps a take with the vendor so `held`/`answerHeld()` drive the in-flight caps.
struct FakeTranscriber : Transcriber {
  bool on = true;
  bool answers = true;
  bool hold = false;
  std::string reply = "rain all morning";
  std::string lastAudio;
  std::string lastMime;
  std::string lastUser;
  int calls = 0;
  std::vector<std::function<void(std::optional<Transcript>)>> held;

  bool configured() const override { return on; }
  void transcribe(const UserId& user, const std::string& audio, const std::string& mimeType,
                  std::function<void(std::optional<Transcript>)> done) override {
    lastAudio = audio;
    lastMime = mimeType;
    lastUser = user.str();
    ++calls;
    if (hold) {
      held.push_back(std::move(done));
      return;
    }
    done(answers ? std::optional<Transcript>{Transcript{reply}} : std::nullopt);
  }

  void answerHeld() {
    std::vector<std::function<void(std::optional<Transcript>)>> waiting;
    waiting.swap(held);
    for (auto& done : waiting) done(answers ? std::optional<Transcript>{Transcript{reply}} : std::nullopt);
  }
};

}
