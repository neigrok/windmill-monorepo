#pragma once

#include "ports/TendRunRepository.h"

#include <string>

namespace wm {

class PgTendRunRepository : public TendRunRepository {
public:
  explicit PgTendRunRepository(std::string connString);

  void save(const TendRun& run) override;
  std::optional<TendRun> find(const std::string& id) override;
  int countForUser(const UserId& user, std::uint64_t sinceMs) override;
  int failOrphanedRuns() override;

private:
  std::string connString_;
};

}
