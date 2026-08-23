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
  std::set<std::string> unreadable;                // users whose load throws
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
    // The real one writes every column BUT `suppressed`: only liftSuppression clears the provider's
    // verdict — mirrored here, or a test could pass against a fake whose upsert quietly does it.
    const bool suppressed = settings[user.str()].suppressed;
    settings[user.str()] = row;
    settings[user.str()].suppressed = suppressed;
  }

  // MailSuppression, keyed by address exactly like the real one: a provider event carries nothing
  // else. An address nobody owns writes nothing and answers false, and the row is created when it
  // is missing so an account whose device never pushed a schedule still remembers the mailbox died.
  bool stopMailing(const Email& address) override {
    for (const auto& [user, owned] : emails)
      if (owned.value == address.value) {
        settings[user].suppressed = true;
        return true;
      }
    return false;
  }
  // The inverse by user id, and like the real UPDATE it creates nothing: a row that never existed
  // has nothing to lift. `enabled` stays exactly as it was.
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

// The nudge mailer as a fake: the daily nudge arrives fully rendered, so it keeps the whole mail and
// the recipient, and the sweep's tests read the pause and settings links straight back off it. Async
// like the real sender but resolves inline — failNext makes the next send report false, recording
// nothing, exactly as a refused provider call would.
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

// A deterministic stand-in for the server-side embedding model: normalised per-letter counts over
// the 26 lowercase letters. Same text embeds to the same vector (cosine 1), text sharing most of its
// letters cosines close, and text over a disjoint set cosines low — enough for the echo sweep to
// A deterministic stand-in for a real embedding model: a 26-dim letter-frequency vector, unit
// normalised, so two passages sharing letters sit close and a test can reason about cosine without
// a model. `isConfigured` flips so a test can exercise the "unwired — the whole pass is a no-op"
// path, and `failNext` returns short so a test can prove a failed embed never marks a page done.
// Cuts a page the way the shipped RULE did — lines, then sentences — so a test that is not about
// segmentation reads exactly as it did before step 1 became a vendor call. `units` overrides that
// for the tests that ARE about it, including the ones that hand back text the page does not
// contain, which is the answer the verbatim check exists for.
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

// Keeps or rejects every pairing wholesale, and can fail the CALL — which the sweep must treat as
// completely different from finding nothing, since only one of the two owes the page a retry.
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

// An in-memory EchoRepository the sweep's tests drive by hand. Spans and echoes are stored the way
// the real adapter stores them — replace-a-page-atomically, identities minted on demand — so a test
// asserting "the pass carried this identity forward" is asserting the same thing production does.
class FakeEchoRepository : public EchoRepository {
public:
  struct StoredSpan {
    LocalDate day;
    SpanWrite write;
    std::string embedVersion;
  };

  // What the reader said about a pairing, with the score and the curator version it was judged
  // under carried alongside — the two columns that make journal_echo_signal a dataset.
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
  // Waved-away pairs, keyed on the two passages' NORMALISED TEXT and scoped to one user, exactly
  // as the SQL keys them on their content hashes. Storing span ids here instead would let a test
  // pass while production resurrected a dismissed echo the first time a sentence moved.
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
  // Plant an already-derived page, the way a night that ran before this one would have left it.
  // `lo` is the passage's byte offset into that page's body, which is what tells two identical
  // sentences apart — the default puts the passage at the top, which is where a one-passage page
  // has it anyway.
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

  // A test drives what is owed through `due`, so the version clause the SQL carries is modelled
  // rather than reimplemented: `staleVersions` is the switch a test flips to say "this page was
  // derived by a pipeline that has since moved", which is what the SQL's IS DISTINCT FROM decides.
  std::vector<DuePage> duePages(const UserId& user, std::uint64_t,
                                const PipelineVersions&) override {
    auto it = due.find(user.str());
    if (it == due.end()) return {};
    return it->second;
  }

  // The one named row, the way the SQL asks it. A test drives what is owed through `due`, and a
  // page derived by the live path takes itself off that list — which is what makes "the second of
  // two debounced saves costs nothing" assertable here rather than only against Postgres.
  std::optional<DuePage> duePage(const UserId& user, const LocalDate& day, std::uint64_t,
                                 const PipelineVersions&) override {
    auto it = due.find(user.str());
    if (it == due.end()) return std::nullopt;
    for (const DuePage& page : it->second)
      if (page.day == day) return page;
    return std::nullopt;
  }

  // A page stops being owed once it has been derived, exactly as advancing body_stamp_ms takes it
  // out of the duePages query. Only a SETTLED pass calls this — a failure that clears leaves it owed.
  void settle(const UserId& user, const LocalDate& day) {
    std::vector<DuePage>& pages = due[user.str()];
    pages.erase(std::remove_if(pages.begin(), pages.end(),
                               [&](const DuePage& page) { return page.day == day; }),
                pages.end());
  }

  // The page as it stands, whether or not anything is owed on it — what the reverse edge reads to
  // re-derive a page whose own body never moved. `bodyMoved` false is the whole point: that page's
  // text is unchanged, so its units are read back rather than bought again.
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

  // Hands back what it stored, minted identities and all — the same contract the SQL keeps with its
  // RETURNING clause, and the one a warm corpus splices on.
  std::vector<Vectored> replaceSpans(const UserId& user, const LocalDate& day,
                                     const std::vector<SpanWrite>& writes,
                                     const std::string& embedVersion, std::uint64_t) override {
    // Every derivation that got past the embedder lands here, so this list is the ORDER the pages
    // were worked in — which is what a fairness test asserts against, and it stays true whether or
    // not a page ended up proposing anything for the curator to judge.
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
    // ORDER BY day, ord, like the SQL — the order is part of the port's contract, and a cache that
    // claims to serve the same bytes has to be asserted against the same order.
    std::stable_sort(corpus.begin(), corpus.end(), [&](const Vectored& a, const Vectored& b) {
      if (!(a.day == b.day)) return a.day < b.day;
      const StoredSpan* left = spanOf(user, a.spanId);
      const StoredSpan* right = spanOf(user, b.spanId);
      return left && right && left->write.passage.ord < right->write.passage.ord;
    });
    return corpus;
  }

  // One span by identity, or nothing at all — the same INNER join the SQL does, so an echo aimed
  // at a passage that died with the last re-derivation is invisible here too.
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
    // Content in, identities out: every span on this page carrying dismissed text is dismissed
    // against every earlier span carrying its partner's text, which is what makes a dismissal
    // survive a re-segmentation that minted brand new span ids.
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

  // Content in, and only content: the same key the SQL writes, so a test that dismisses a pair is
  // dismissing what the two passages SAY and not where they sit.
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

  // "Not now" lives in its own set and touches nothing else — the same separation the SQL keeps,
  // where declining the offer writes one row in its own table and journal_echo never moves.
  void dismissOffer(const UserId& user, const LocalDate& day) override {
    offersRetired.insert(pageKey(user, day));
  }

  // Signals are stored with the retrieval score and the curator's version copied off the echo row,
  // exactly as the INSERT ... SELECT does — a fake that kept only the kind would let a test pass
  // while production wrote a tally instead of a dataset.
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

  void replaceEchoes(const UserId& user, const LocalDate& day,
                     const CuratedEchoes& curated) override {
    echoesByPage[pageKey(user, day)] = curated;
  }
  // A SETTLED pass advances the page's stamps, which is what takes it off the owed list; a failure
  // that will clear on its own writes the error and leaves both stamps where they were, so the page
  // is still owed. Mirrored here exactly, because "a failed curate leaves the page still due" and
  // "a refused page never comes back" are both claims about this branch, and a fake that settled
  // either way would let both pass while production lost the page or billed it forever.
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

  // The reader's view, assembled the way the SQL assembles it: both spans join INNER, dismissed
  // pairs are gone, the passages travel as text, and the anchoring hint is counted against the
  // match page as it stands right now — so a body edited under a passage yields -1 here too.
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

  // Pages worked, oldest call first — see replaceSpans.
  std::vector<std::string> derived;

  // What one page ended up carrying, for a test that wants to assert the whole set at once.
  std::vector<EchoRow> rowsOn(const UserId& user, const LocalDate& day) {
    auto it = echoesByPage.find(pageKey(user, day));
    if (it == echoesByPage.end()) return {};
    return it->second.rows;
  }
};

// A transcriber the voice tests drive: `on` toggles configured() (the 503 path), `answers` toggles
// the vendor failure (the 502 path), and transcribe returns a fixed line plus the last audio/mime and
// user it saw, so a test can assert the bytes reached it and whose spend it was.
//
// `hold` keeps a take with the "vendor" instead of answering it, which is how a test drives the
// in-flight caps: the callbacks pile up in `held` and `answerHeld()` releases them.
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
