#pragma once

#include "products/gym/ports/PreferencesRepository.h"

namespace wm::gym {

// Settings (§I) — one of five services, each over the aggregate port of the same name
// (TrainingService, CatalogService, ProgramService, ThreadService are the other four). Two doors,
// the HTTP one and nothing else today, and it stands on its own rather than riding on the log's
// service so that PreferencesApi holds exactly the port it reads and a rule about the log cannot
// come to depend on the settings, or the reverse, without a constructor saying so.
//
// The read answers the DEFAULTS where nothing is stored rather than an absence, because every
// client needs the rest target and the reading unit to draw its first frame — a 404 there would
// put a copy of the defaults in each of them, and the fourth copy is the one that disagrees.
//
// The write is the WHOLE document, the shape a routine travels in and for the shape's own reason:
// the settings screen renders every row from one value it already holds, so it always has the
// whole document in hand, and a partial write would need "omitted" and "cleared" to be different
// things on the one field whose absence already means something — an absent rest target IS the
// timer off. It answers with the stored row, so a client draws what the store now holds.
class PreferencesService {
public:
  explicit PreferencesService(PreferencesRepository& preferences);

  GymPreferences preferences(const UserId& user);
  GymPreferences savePreferences(const GymPreferences& incoming);

private:
  PreferencesRepository& preferences_;
};

}
