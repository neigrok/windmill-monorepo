#pragma once

#include "products/gym/domain/Preferences.h"
#include "products/gym/domain/Training.h"

#include <optional>

namespace wm::gym {

// The settings row's door to gym storage (§I), and the smallest of the five aggregate ports over
// one Postgres database (LogRepository, CatalogRepository, ProgramRepository, AskThreadRepository
// are the others) — its own port rather than two methods on the log's because it is the one table
// that is not the log. Owner-scoped by the UserId the document carries.
struct PreferencesRepository {
  virtual ~PreferencesRepository() = default;

  // The settings row (§I), and the one value in gym's storage a lifter is allowed to have none of: a
  // lifter who has never opened that screen has no row, which is a fact rather than a fault. The
  // DEFAULTS are the domain's answer to it (domain/Preferences.h) and PreferencesService is where they are
  // given, so the store says "nothing stored" and never invents a document nobody wrote.
  // `savePreferences` is a whole-document upsert keyed on the account — idempotent by SHAPE like the
  // two set writes rather than by a client-minted id, because there is one row per lifter and
  // nothing here for a client to name — and it answers with the row as the store now holds it.
  //
  // NO OTHER PORT READS IT, and that is §I's first row made structural: units are a display
  // transform at the very edge, so no read in the log, the catalog or the program is scoped by them,
  // no write converts anything, and kilograms stay the only load this store has ever held.
  virtual std::optional<GymPreferences> preferences(const UserId& user) = 0;
  virtual GymPreferences savePreferences(const GymPreferences& incoming) = 0;
};

}
