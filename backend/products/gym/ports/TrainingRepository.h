#pragma once

#include "products/gym/ports/AskThreadRepository.h"
#include "products/gym/ports/CatalogRepository.h"
#include "products/gym/ports/LogRepository.h"
#include "products/gym/ports/PreferencesRepository.h"
#include "products/gym/ports/ProgramRepository.h"

namespace wm::gym {

// The five aggregate ports as one door, kept only while the one Postgres adapter and the one fake
// still implement all five in a single class; it goes when they are split.
struct TrainingRepository : LogRepository,
                            CatalogRepository,
                            ProgramRepository,
                            AskThreadRepository,
                            PreferencesRepository {};

}
