#pragma once

#include "products/journal/domain/Page.h"

#include <cstddef>

namespace wm {

// Told after a commit that changed a stored page, with the winning body's size. Implementations must
// return immediately: it is called on the thread that committed.
struct PageWatcher {
  virtual ~PageWatcher() = default;
  virtual void pageSaved(const UserId& user, const LocalDate& day, std::size_t bodyBytes) = 0;
};

}
