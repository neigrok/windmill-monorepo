#pragma once

#include "products/journal/ports/JournalRepository.h"

#include <optional>
#include <vector>

namespace wm {

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
  explicit PageService(JournalRepository& repo);

  WriteOutcome write(const Page& incoming);
  std::optional<Page> page(const UserId& user, const LocalDate& day);
  std::vector<Page> range(const UserId& user, const LocalDate& from, const LocalDate& to);
  std::vector<Page> since(const UserId& user, const Hlc& cursor, int limit);
  std::vector<Page> all(const UserId& user);

private:
  JournalRepository& repo_;
};

}
