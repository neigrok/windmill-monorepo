#pragma once

#include "products/gym/domain/Preferences.h"
#include "products/gym/domain/Training.h"

#include <optional>

namespace wm::gym {

// The settings row as the engine stores it, owner-scoped by the UserId it carries. A lifter who never
// changed a setting has no row; the store never invents a document, the defaults being
// PreferencesService's to give.
struct PreferencesRepository {
  virtual ~PreferencesRepository() = default;

  virtual std::optional<GymPreferences> preferences(const UserId& user) = 0;
};

}
