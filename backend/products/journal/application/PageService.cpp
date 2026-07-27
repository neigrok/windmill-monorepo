#include "products/journal/application/PageService.h"

namespace wm {

PageService::PageService(JournalRepository& repo) : repo_(repo) {}

// Write, then re-read the day and return whatever won. A client that raced and lost gets handed the
// winning body, not the stale one it sent — so the canvas is honest on the same round trip. A row
// always exists after a save; the nullopt branch only guards against a repository that lies.
WriteOutcome PageService::write(const Page& incoming) {
  PageWrite result = repo_.save(incoming);
  std::optional<Page> winner = repo_.load(incoming.user, incoming.day);
  if (!winner) return {incoming, result};
  return {*winner, result};
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
