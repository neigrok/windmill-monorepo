#include "products/gym/application/PreferencesService.h"

namespace wm::gym {

PreferencesService::PreferencesService(PreferencesRepository& preferences)
    : preferences_(preferences) {}

// A lifter who has never opened the settings screen holds no row, and the answer to that is the
// DEFAULTS rather than an absence: every client needs the rest target and the reading unit before it
// can draw its first frame, so an empty answer would put a copy of the defaults in each of them —
// and the fourth copy is the one that quietly disagrees. Nothing is written on the way out; a lifter who
// never touches this screen never grows a row.
GymPreferences PreferencesService::preferences(const UserId& user) {
  return preferences_.preferences(user).value_or(GymPreferences{user});
}

GymPreferences PreferencesService::savePreferences(const GymPreferences& incoming) {
  return preferences_.savePreferences(incoming);
}

}
