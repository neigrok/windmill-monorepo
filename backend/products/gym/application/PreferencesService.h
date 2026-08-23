#pragma once

#include "products/gym/ports/PreferencesRepository.h"

namespace wm::gym {

// The settings seam. The read answers the DEFAULTS where nothing is stored, never an absence. The
// write is the WHOLE document — a partial write would need "omitted" and "cleared" to differ on the
// one field whose absence already means something, an absent rest target being the timer off — and
// it answers with the stored row.
class PreferencesService {
public:
  explicit PreferencesService(PreferencesRepository& preferences);

  GymPreferences preferences(const UserId& user);
  GymPreferences savePreferences(const GymPreferences& incoming);

private:
  PreferencesRepository& preferences_;
};

}
