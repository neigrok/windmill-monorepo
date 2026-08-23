#pragma once

#include "products/journal/domain/Page.h"

#include <optional>
#include <vector>

namespace wm {

// What a save decided against the stored stamp. A stale write is a no-op, never an error.
// `superseded` also kept the outgoing body as an invisible revision.
enum class PageWrite { stored, superseded, ignoredStale };

// Every method is owner-scoped by the UserId it carries; a page is legible to exactly one account.
struct JournalRepository {
  virtual ~JournalRepository() = default;

  virtual std::optional<Page> load(const UserId& user, const LocalDate& day) = 0;

  // Pages in [from, to], oldest first.
  virtual std::vector<Page> range(const UserId& user, const LocalDate& from, const LocalDate& to) = 0;

  // Pages whose stamp is strictly greater than the cursor, ascending, capped at `limit`.
  virtual std::vector<Page> since(const UserId& user, const Hlc& cursor, int limit) = 0;

  // Every page a user has, oldest first.
  virtual std::vector<Page> all(const UserId& user) = 0;

  // LWW upsert keyed on (user, day): stores `incoming` only if its stamp dominates the stored one.
  virtual PageWrite save(const Page& incoming) = 0;
};

}
