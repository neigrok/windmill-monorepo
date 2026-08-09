#pragma once

#include "products/journal/ports/JournalRepository.h"

#include <cstddef>
#include <optional>
#include <vector>

namespace wm {

// Told after every save that actually changed the stored page. It exists because echoes are
// computed ON WRITE — a page written tonight used to wait up to six hours for the reaching-back
// that is the whole feature — and the writer's own save is the only honest trigger for that.
//
// The abstraction lives here rather than beside its implementation because this is the side that
// needs it: PageService owes the rest of the product a fact about a save and must not learn what
// anyone does with it. `bodyBytes` rides along so the listener can tell a typo fix from a
// paragraph without reading the page back.
//
// IMPLEMENTATIONS MUST RETURN IMMEDIATELY. This is called on a drogon handler thread, of which
// there are four.
struct PageWatcher {
  virtual ~PageWatcher() = default;
  virtual void pageSaved(const UserId& user, const LocalDate& day, std::size_t bodyBytes) = 0;
};

// The resolved page after a write, with what the LWW guard decided. `page` is always the WINNING
// row (re-read after the upsert), so a client that raced and lost is handed the body that won
// rather than the stale one it sent — the canvas is honest immediately, without a second request.
struct WriteOutcome {
  Page page;
  PageWrite result;
};

// The application seam over journal storage: the HTTP adapter talks to this, never to the
// repository, so persistence stays swappable and the reads/writes have one home. Thin by nature —
// a page is a text blob, not a graph — but it owns the write-then-resolve rule and is where the
// heavier read models (a server-assembled week) would land if they ever move off the device.
class PageService {
public:
  // `watcher` is optional and null in most tests: a service with nobody listening still has to save
  // a page, and the write path must not acquire a dependency it cannot run without.
  explicit PageService(JournalRepository& repo, PageWatcher* watcher = nullptr);

  WriteOutcome write(const Page& incoming);
  std::optional<Page> page(const UserId& user, const LocalDate& day);
  std::vector<Page> range(const UserId& user, const LocalDate& from, const LocalDate& to);
  std::vector<Page> since(const UserId& user, const Hlc& cursor, int limit);
  std::vector<Page> all(const UserId& user);

private:
  JournalRepository& repo_;
  PageWatcher* watcher_;
};

}
