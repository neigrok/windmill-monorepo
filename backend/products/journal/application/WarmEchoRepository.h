#pragma once

#include "platform/ports/Clock.h"
#include "products/journal/ports/EchoRepository.h"

#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace wm {

// The same EchoRepository with one thing held warm: the user's vector corpus.
//
// Every derivation compares tonight's passages against every passage the user has ever written, and
// loading that is the entire cost of a pass — ECHOES.md measures 3.1–12.3 MB and a full round trip
// against the 14 ms the cosine scan itself takes. That was tolerable when a user was derived once a
// night. It is not tolerable now that a save triggers one: a writer touching four pages in an
// evening would pay the corpus load four times to do four scans.
//
// So the corpus is loaded once and kept, per (user, embedding version), for `ttlMs`.
//
// WHAT INVALIDATION GUARANTEES, exactly, because a cache that answers about yesterday's spans is
// worse than a slow one:
//
//   - Every change to journal_span in this process goes through replaceSpans, and replaceSpans
//     hands back what it stored. The warm copy is therefore SPLICED — the day's passages are
//     replaced by the day's passages, minted identities and all — never guessed and never merely
//     dropped. A dropped entry would be correct and useless: each derivation writes its own page,
//     so invalidating on write means the cache is cold at every single read.
//   - A write under a DIFFERENT embedding version drops the entry outright. Retrieval reads one
//     version only, and splicing across two would be a corpus that silently mixes spaces.
//   - Nothing else in this process writes a span, so within one process the warm copy is exact.
//   - ACROSS processes it is not, and the TTL is the whole bound: a second writer's spans are
//     invisible here for at most `ttlMs`. That is why the default is fifteen minutes and not a day.
//     Today's deploy runs one backend container, so the window is theory; it stops being theory the
//     moment a second replica exists, and a shorter TTL is the answer, not a longer one.
//
// WHAT IT COSTS: one warm user is their whole corpus in memory — 12.3 MB at ECHOES.md's 8,000
// passages × 384 float32 dims, and about 3 MB for a corpus of a couple of thousand. Entries are
// dropped on the first call after they expire, so the ceiling is the number of distinct users
// deriving inside one TTL window rather than the number of accounts. A busy fifteen minutes with
// twenty writers in it is therefore a few hundred megabytes at the 8,000-passage extreme; if that
// ever stops being affordable, the lever is the TTL, and after that a bound on entries.
//
// Every other call forwards untouched. It is an EchoRepository so that the read layer, the live
// path and the repair pass can all hold the same one and none of them has to know it is warm.
class WarmEchoRepository : public EchoRepository {
public:
  WarmEchoRepository(EchoRepository& storage, Clock& clock, std::uint64_t ttlMs = 15 * 60 * 1000);

  std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) override;
  std::vector<Vectored> replaceSpans(const UserId& user, const LocalDate& day,
                                     const std::vector<SpanWrite>& spans,
                                     const std::string& embedVersion,
                                     std::uint64_t bodyStampMs) override;

  std::vector<EchoUser> activeSince(std::uint64_t sinceMs) override;
  std::uint64_t corpusStamp(const UserId& user) override;
  std::vector<DuePage> duePages(const UserId& user, std::uint64_t corpusStamp,
                                const PipelineVersions& versions) override;
  std::optional<DuePage> duePage(const UserId& user, const LocalDate& day,
                                 std::uint64_t corpusStamp,
                                 const PipelineVersions& versions) override;
  std::optional<DuePage> pageAt(const UserId& user, const LocalDate& day) override;
  std::vector<KnownSpan> spansOf(const UserId& user, const LocalDate& day) override;
  std::vector<SpanPair> dismissalsOn(const UserId& user, const LocalDate& triggerDay) override;
  void dismissPair(const UserId& user, const LocalDate& triggerDay,
                   const LocalDate& matchDay) override;
  void dismissPage(const UserId& user, const LocalDate& triggerDay) override;
  void dismissOffer(const UserId& user, const LocalDate& day) override;
  void recordSignal(const UserId& user, const LocalDate& triggerDay, const LocalDate& matchDay,
                    EchoSignal kind) override;
  void recordPageSignal(const UserId& user, const LocalDate& triggerDay, EchoSignal kind) override;
  void replaceEchoes(const UserId& user, const LocalDate& triggerDay,
                     const CuratedEchoes& curated) override;
  void recordCuration(const UserId& user, const LocalDate& day,
                      const CurationOutcome& outcome) override;
  std::vector<LocalDate> inboundPages(const UserId& user, const LocalDate& matchDay) override;
  std::vector<EchoView> echoesFor(const UserId& user, const LocalDate& from,
                                  const LocalDate& to) override;
  std::vector<LocalDate> retiredOffers(const UserId& user, const LocalDate& from,
                                       const LocalDate& to) override;
  int pagesWritten(const UserId& user) override;

  // How many corpus loads this instance actually paid for. Kept because "the cache is warm" is a
  // claim about a number, and an operator with no number is guessing.
  int loads() const;

  // How many users are held warm right now. Exists for the eviction test: a cache whose expiry is
  // only ever checked on read looks identical to one that frees nothing, and the difference is a
  // process that survives the month.
  int warmUsers() const;

private:
  // One user's corpus, held by day so a re-derived page is one map assignment. Day-keyed and
  // ISO-keyed on purpose: the flattened read then comes out ordered (day, ord) — the exact order
  // corpusOf serves — without a sort, because an ISO day sorts lexicographically and a page's
  // passages arrive in document order.
  struct Warm {
    std::string embedVersion;
    std::uint64_t loadedAtMs = 0;
    std::map<std::string, std::vector<Vectored>> byDay;
  };

  EchoRepository& storage_;
  Clock& clock_;
  std::uint64_t ttlMs_;
  mutable std::mutex lock_;
  std::map<std::string, Warm> warm_;
  // How many span writes this user has taken, ever. Compared across a load to notice that the
  // corpus moved while it was being fetched — the one window in which a warm copy could be born
  // already stale.
  std::map<std::string, std::uint64_t> writes_;
  int loads_ = 0;
};

}
