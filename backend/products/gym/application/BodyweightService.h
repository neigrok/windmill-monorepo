#pragma once

#include "products/gym/ports/BodyweightRepository.h"

#include <optional>
#include <string>
#include <vector>

namespace wm::gym {

// A lifter's weigh-ins. Reads and writes are pass-throughs to the store, which decides the one
// rule (the later `recordedAt` wins); no server clock is involved here, because a weigh-in is dated
// by the lifter's calendar and ordered by the device's clock. The one opinion a server clock has —
// a day past UTC tomorrow is a forecast — is the HTTP door's (`BodyweightApi`), not this seam's.
// This is the one seam both doors hold — the HTTP adapter and the `list_bodyweight` tool — and no
// tool at any grant level reaches `save` or `remove`: a weigh-in is a fact only the lifter observed.
class BodyweightService {
public:
  explicit BodyweightService(BodyweightRepository& bodyweight);

  std::vector<Bodyweight> entries(const UserId& user, const BodyweightRange& range);
  std::optional<Bodyweight> latest(const UserId& user);
  Bodyweight save(const Bodyweight& incoming);
  // A day that is not a calendar day names nothing, so it is the same no-op as an absent row: the
  // store never sees a string its date column cannot read.
  void remove(const UserId& user, const std::string& dateLocal);
  std::vector<ExportedBodyweight> exported(const UserId& user);

private:
  BodyweightRepository& bodyweight_;
};

}
