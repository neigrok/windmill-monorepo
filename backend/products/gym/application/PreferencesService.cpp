#include "products/gym/application/PreferencesService.h"
#include "products/gym/application/GymSwitches.h"
#include "products/gym/ports/GymWriteDoor.h"

namespace wm::gym {

PreferencesService::PreferencesService(PreferencesRepository& preferences, GymWriteDoor* door)
    : door_(door), preferences_(preferences) {}

// A lifter who has never opened the settings screen holds no row and reads the DEFAULTS. Nothing is
// written on the way out.
GymPreferences PreferencesService::preferences(const UserId& user) {
  return preferences_.preferences(user).value_or(GymPreferences{user});
}

GymPreferences PreferencesService::savePreferences(const GymPreferences& incoming) {
  requireGymWrite();
  if (door_ && gymEngineWrites()) return door_->savePreferences(incoming);
  return preferences_.savePreferences(incoming);
}

}
