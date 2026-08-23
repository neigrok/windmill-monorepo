#pragma once

#include "products/gym/ports/PreferencesRepository.h"

namespace wm::gym {

// The read answers the DEFAULTS where nothing is stored, never an absence. The write is the WHOLE
// document and answers with the stored row.
class PreferencesService {
public:
  explicit PreferencesService(PreferencesRepository& preferences);

  GymPreferences preferences(const UserId& user);
  GymPreferences savePreferences(const GymPreferences& incoming);

private:
  PreferencesRepository& preferences_;
};

}
