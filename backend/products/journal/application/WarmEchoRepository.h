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

// The same EchoRepository with the user's vector corpus held warm, per (user, embedding version),
// for `ttlMs`. Every other call forwards untouched.
//
//   - replaceSpans hands back what it stored, so the warm copy is spliced rather than dropped.
//   - A write under a different embedding version drops the entry: retrieval reads one version only.
//   - Across processes the copy is not exact, and the TTL is the whole bound.
class WarmEchoRepository : public EchoRepository {
public:
  WarmEchoRepository(EchoRepository& storage, Clock& clock, std::uint64_t ttlMs = 15 * 60 * 1000);

  std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) override;
  std::vector<Vectored> replaceSpans(const UserId& user, const LocalDate& day,
                                     const std::vector<SpanWrite>& spans,
                                     const std::string& embedVersion, const std::string& body,
                                     std::uint64_t bodyStampMs) override;

  std::vector<EchoUser> activeSince(std::uint64_t sinceMs) override;
  std::uint64_t corpusStamp(const UserId& user) override;
  std::vector<DuePage> duePages(const UserId& user, std::uint64_t corpusStamp,
                                const PipelineVersions& versions) override;
  std::optional<DuePage> duePage(const UserId& user, const LocalDate& day,
                                 std::uint64_t corpusStamp,
                                 const PipelineVersions& versions) override;
  std::optional<DuePage> pageAt(const UserId& user, const LocalDate& day) override;
  std::vector<DuePage> allPages(const UserId& user) override;
  std::vector<StoredSpan> spansOf(const UserId& user, const LocalDate& day) override;
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
  void clearEchoes(const UserId& user, const LocalDate& triggerDay) override;
  void recordCuration(const UserId& user, const LocalDate& day,
                      const CurationOutcome& outcome) override;
  std::vector<LocalDate> inboundPages(const UserId& user, const LocalDate& matchDay) override;
  std::vector<EchoView> echoesFor(const UserId& user, const LocalDate& from,
                                  const LocalDate& to) override;
  std::vector<LocalDate> retiredOffers(const UserId& user, const LocalDate& from,
                                       const LocalDate& to) override;
  int pagesWritten(const UserId& user) override;

  // How many corpus loads this instance actually paid for.
  int loads() const;

  // How many users are held warm right now.
  int warmUsers() const;

private:
  // Held by day so a re-derived page is one map assignment. ISO-day keys make the flattened read
  // come out ordered (day, ord), the order corpusOf serves, without a sort.
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
  // Span writes taken per user, ever; compared across a load to notice the corpus moved mid-fetch.
  std::map<std::string, std::uint64_t> writes_;
  int loads_ = 0;
};

}
