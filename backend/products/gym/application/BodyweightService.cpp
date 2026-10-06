#include "products/gym/application/BodyweightService.h"

namespace wm::gym {

BodyweightService::BodyweightService(BodyweightRepository& bodyweight) : bodyweight_(bodyweight) {}

std::vector<Bodyweight> BodyweightService::entries(const UserId& user,
                                                   const BodyweightRange& range) {
  return bodyweight_.entries(user, range);
}

std::optional<Bodyweight> BodyweightService::latest(const UserId& user) {
  return bodyweight_.latest(user);
}

}
