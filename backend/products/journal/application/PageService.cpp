#include "products/journal/application/PageService.h"

namespace wm {

PageService::PageService(JournalRepository& repo) : repo_(repo) {}

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
