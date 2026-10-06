#include "products/gym/application/PreferencesService.h"

namespace wm::gym {

PreferencesService::PreferencesService(PreferencesRepository& preferences) : preferences_(preferences) {}

// A lifter who has never changed a setting holds no row and reads the DEFAULTS. Nothing is written on
// the way out.
GymPreferences PreferencesService::preferences(const UserId& user) {
  return preferences_.preferences(user).value_or(GymPreferences{user});
}

}
