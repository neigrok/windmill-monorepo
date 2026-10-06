#pragma once

#include "products/gym/domain/Training.h"

#include <vector>

namespace wm::gym {

// The global seeds, this account's own movements, and the per-account names and aliases a rename
// leaves on either. Owner-scoped by the UserId it carries: a seed has no owner, and `custom` is derived
// from created_by. Sets, routine lines and proposal lines name movements under this same visibility.
struct CatalogRepository {
  virtual ~CatalogRepository() = default;

  virtual std::vector<Exercise> catalog(const UserId& user) = 0;          // seeds + own customs
};

}
