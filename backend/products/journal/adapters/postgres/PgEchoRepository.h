#pragma once

#include "platform/adapters/postgres/PgPool.h"
#include "products/journal/ports/EchoRepository.h"

#include <memory>
#include <string>

namespace wm {

// Echo storage over Postgres. Stateless but for the connection string; every read owner-scoped.
//
// Vectors live in a bytea as little-endian float32 and are matched in memory by the pure selection
// domain; pgvector stays an escape hatch behind this class rather than a dependency in front of it.
//
// Portability rules hold throughout: day::text, epoch-ms bigints, a template<Row> mapper, and bytea
// moved as its own hex text in BOTH directions. The dev box is on libpqxx 8 and the CI image builds
// 7.10, so nothing here touches a pqxx binary, date or array reader.
class PgEchoRepository : public EchoRepository {
public:
  explicit PgEchoRepository(std::shared_ptr<PgPool> pool);

  std::vector<EchoUser> activeSince(std::uint64_t sinceMs) override;

  std::uint64_t corpusStamp(const UserId& user) override;
  std::vector<DuePage> duePages(const UserId& user, std::uint64_t corpusStamp,
                                const PipelineVersions& versions) override;
  std::optional<DuePage> duePage(const UserId& user, const LocalDate& day,
                                 std::uint64_t corpusStamp,
                                 const PipelineVersions& versions) override;

  std::optional<DuePage> pageAt(const UserId& user, const LocalDate& day) override;
  std::vector<DuePage> allPages(const UserId& user) override;
  std::vector<KnownSpan> spansOf(const UserId& user, const LocalDate& day) override;
  std::vector<Vectored> replaceSpans(const UserId& user, const LocalDate& day,
                                     const std::vector<SpanWrite>& spans,
                                     const std::string& embedVersion,
                                     std::uint64_t bodyStampMs) override;

  std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) override;

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

private:
  std::shared_ptr<PgPool> pool_;
};

}
