#pragma once

#include "products/gym/domain/Preferences.h"
#include "products/gym/domain/Training.h"

#include <optional>

namespace wm::gym {

// The settings row's door to gym storage, owner-scoped by the UserId the document carries.
struct PreferencesRepository {
  virtual ~PreferencesRepository() = default;

  // A lifter who never opened that screen has no row; the store never invents a document, the
  // defaults being PreferencesService's to give. `savePreferences` is a whole-document upsert keyed
  // on the account, idempotent by shape, answering with the row as the store now holds it.
  virtual std::optional<GymPreferences> preferences(const UserId& user) = 0;
  virtual GymPreferences savePreferences(const GymPreferences& incoming) = 0;
};

}
