#pragma once

#include "products/journal/domain/Page.h"

#include <optional>
#include <vector>

namespace wm {

// What a save decided against the stored stamp. A stale write is a no-op, never an error.
// `superseded` is the one case that also kept the outgoing body as an invisible revision.
enum class PageWrite { stored, superseded, ignoredStale };

// The one door to journal storage. Every method is owner-scoped by the UserId it carries; there is
// no visibility axis and no share entity, so a page is legible to exactly one account. The sole
// write is a last-writer-wins upsert keyed on (user, day) and guarded by the HLC stamp.
struct JournalRepository {
  virtual ~JournalRepository() = default;

  virtual std::optional<Page> load(const UserId& user, const LocalDate& day) = 0;

  // The canvas window / the week: a user's pages in [from, to], oldest first.
  virtual std::vector<Page> range(const UserId& user, const LocalDate& from, const LocalDate& to) = 0;

  // The delta feed: pages whose stamp is strictly greater than the cursor, ascending, capped at
  // `limit`. It never takes a query — a sync feed, not a search feed.
  virtual std::vector<Page> since(const UserId& user, const Hlc& cursor, int limit) = 0;

  // Export: every page a user has, oldest first.
  virtual std::vector<Page> all(const UserId& user) = 0;

  // LWW upsert. Stores `incoming` only if its stamp dominates the stored one; returns what it
  // decided, so a fresh write and a no-op are distinguishable without a second read.
  virtual PageWrite save(const Page& incoming) = 0;
};

}
