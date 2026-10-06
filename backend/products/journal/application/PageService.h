#pragma once

#include "products/journal/ports/JournalRepository.h"

#include <optional>
#include <vector>

namespace wm {

// The HTTP adapter and the echo explainer read pages through this, never through the repository.
// Pages are written on a device and arrive through /v1/sync.
class PageService {
public:
  explicit PageService(JournalRepository& repo);

  std::optional<Page> page(const UserId& user, const LocalDate& day);
  std::vector<Page> range(const UserId& user, const LocalDate& from, const LocalDate& to);
  std::vector<Page> since(const UserId& user, const Hlc& cursor, int limit);
  std::vector<Page> all(const UserId& user);

private:
  JournalRepository& repo_;
};

}
