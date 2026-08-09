#include "products/journal/application/PageService.h"

namespace wm {

PageService::PageService(JournalRepository& repo, PageWatcher* watcher)
    : repo_(repo), watcher_(watcher) {}

// Write, then re-read the day and return whatever won. A client that raced and lost gets handed the
// winning body, not the stale one it sent — so the canvas is honest on the same round trip. A row
// always exists after a save; the nullopt branch only guards against a repository that lies.
//
// Then tell whoever is listening, because this is where echoes are triggered from. Two details are
// deliberate. A write that LOST the last-writer-wins guard changed nothing, so it announces
// nothing — a phone pushing a stale body must not buy a derivation of a page it did not move. And
// the announcement names the WINNING body, not the incoming one, so what is derived is what is
// stored. The call must return immediately; this is a request thread.
WriteOutcome PageService::write(const Page& incoming) {
  PageWrite result = repo_.save(incoming);
  std::optional<Page> winner = repo_.load(incoming.user, incoming.day);
  const Page settled = winner ? *winner : incoming;
  if (watcher_ && result != PageWrite::ignoredStale)
    watcher_->pageSaved(settled.user, settled.day, settled.body.size());
  return {settled, result};
}

std::optional<Page> PageService::page(const UserId& user, const LocalDate& day) {
  return repo_.load(user, day);
}

std::vector<Page> PageService::range(const UserId& user, const LocalDate& from, const LocalDate& to) {
  return repo_.range(user, from, to);
}

std::vector<Page> PageService::since(const UserId& user, const Hlc& cursor, int limit) {
  return repo_.since(user, cursor, limit);
}

std::vector<Page> PageService::all(const UserId& user) {
  return repo_.all(user);
}

}
