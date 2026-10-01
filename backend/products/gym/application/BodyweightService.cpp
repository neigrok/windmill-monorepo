#include "products/gym/application/BodyweightService.h"
#include "products/gym/application/GymSwitches.h"
#include "products/gym/ports/GymWriteDoor.h"

namespace wm::gym {

BodyweightService::BodyweightService(BodyweightRepository& bodyweight, GymWriteDoor* door) : door_(door), bodyweight_(bodyweight) {}

std::vector<Bodyweight> BodyweightService::entries(const UserId& user,
                                                   const BodyweightRange& range) {
  return bodyweight_.entries(user, range);
}

std::optional<Bodyweight> BodyweightService::latest(const UserId& user) {
  return bodyweight_.latest(user);
}

Bodyweight BodyweightService::save(const Bodyweight& incoming) {
  requireGymWrite();
  if (door_ && gymEngineWrites()) return door_->saveBodyweight(incoming);
  return bodyweight_.save(incoming);
}

void BodyweightService::remove(const UserId& user, const std::string& dateLocal) {
  requireGymWrite();
  if (!wellFormedLocalDate(dateLocal)) return;
  if (door_ && gymEngineWrites()) { door_->deleteBodyweight(user, dateLocal); return; }
  bodyweight_.remove(user, dateLocal);
}

}
