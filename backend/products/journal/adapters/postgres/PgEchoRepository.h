#pragma once

#include "products/journal/ports/EchoRepository.h"

#include <string>

namespace wm {

// Echo + page-vector storage over Postgres. Vectors are float4[] and matched in-memory by the pure
// EchoFinder — no pgvector dependency at journal's data scale. Stateless but for the connection
// string; every read owner-scoped; the mac-vs-CI portability rules hold (day::text, epoch-ms
// bigints, a template<Row> mapper). saveEcho upserts on (user, trigger_day, match_day).
class PgEchoRepository : public EchoRepository {
public:
  explicit PgEchoRepository(std::string connString);

  std::vector<EchoUser> activeSince(std::uint64_t sinceMs) override;
  std::vector<PageText> pagesNeedingVector(const UserId& user) override;
  void saveVector(const UserId& user, const LocalDate& day, const std::vector<float>& vector,
                  std::uint64_t bodyStampMs) override;
  std::vector<EchoCandidate> corpusOf(const UserId& user) override;
  std::vector<LocalDate> triggersSince(const UserId& user, std::uint64_t sinceMs) override;
  void saveEcho(const UserId& user, const LocalDate& triggerDay, const EchoMatch& match) override;
  std::vector<StoredEcho> echoesFor(const UserId& user, const LocalDate& from,
                                    const LocalDate& to) override;
  void dismiss(const UserId& user, const LocalDate& triggerDay) override;

private:
  std::string connString_;
};

}
