#pragma once

#include "products/gym/ports/PreferencesRepository.h"

namespace wm::gym {

// The read answers the DEFAULTS where nothing is stored, never an absence. A phone writes the settings
// through /v1/sync.
class PreferencesService {
public:
  explicit PreferencesService(PreferencesRepository& preferences);

  GymPreferences preferences(const UserId& user);

private:
  PreferencesRepository& preferences_;
};

}
