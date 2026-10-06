#pragma once

#include "products/gym/ports/BodyweightRepository.h"

#include <optional>
#include <vector>

namespace wm::gym {

// A lifter's weigh-ins, read. The one seam both doors hold — the HTTP read and the `list_bodyweight`
// tool. A weigh-in is written on a phone through /v1/sync and by no tool at any grant level: it is a
// fact only the lifter observed.
class BodyweightService {
public:
  explicit BodyweightService(BodyweightRepository& bodyweight);

  std::vector<Bodyweight> entries(const UserId& user, const BodyweightRange& range);
  std::optional<Bodyweight> latest(const UserId& user);

private:
  BodyweightRepository& bodyweight_;
};

}
