#pragma once

#include "products/journal/ports/EchoRepository.h"

#include <string>

namespace wm {

// Echo storage over Postgres. Stateless but for the connection string; every read owner-scoped.
//
// Vectors live in a bytea as little-endian float32 and are matched in memory by the pure selection
// domain — brute force is correct at journal's scale and keeps exact recall measurable, and pgvector
// stays the escape hatch behind this class rather than a dependency in front of it.
//
// The mac-vs-CI portability rules hold throughout: day::text, epoch-ms bigints, a template<Row>
// mapper, and bytea moved as its own hex text in BOTH directions. The Homebrew dev box is on
// libpqxx 8 and the CI image builds 7.10, so nothing here touches a pqxx binary or array reader —
// the same reasoning that already keeps every date off pqxx's date parsers.
class PgEchoRepository : public EchoRepository {
public:
  explicit PgEchoRepository(std::string connString);

  std::vector<EchoUser> activeSince(std::uint64_t sinceMs) override;

  std::uint64_t corpusStamp(const UserId& user) override;
  std::vector<DuePage> duePages(const UserId& user, std::uint64_t corpusStamp) override;

  std::vector<KnownSpan> spansOf(const UserId& user, const LocalDate& day) override;
  void replaceSpans(const UserId& user, const LocalDate& day, const std::vector<SpanWrite>& spans,
                    const std::string& embedVersion, std::uint64_t bodyStampMs) override;

  std::vector<Vectored> corpusOf(const UserId& user, const std::string& embedVersion) override;

  std::vector<SpanPair> dismissalsOn(const UserId& user, const LocalDate& triggerDay) override;
  void dismiss(const UserId& user, std::int64_t triggerSpanId, std::int64_t matchSpanId) override;
  void dismissPage(const UserId& user, const LocalDate& triggerDay) override;

  void replaceEchoes(const UserId& user, const LocalDate& triggerDay,
                     const CuratedEchoes& curated) override;
  void recordCuration(const UserId& user, const LocalDate& day,
                      const CurationOutcome& outcome) override;

  std::vector<LocalDate> inboundPages(const UserId& user, const LocalDate& matchDay) override;

  std::vector<EchoView> echoesFor(const UserId& user, const LocalDate& from,
                                  const LocalDate& to) override;
  int pagesWritten(const UserId& user) override;

private:
  std::string connString_;
};

}
