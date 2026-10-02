#pragma once

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Registry.h"

#include <string_view>

namespace wm::journal::engine {

std::string_view registryText();

inline const sync::Registry& registry() {
  static const sync::Registry journal{sync::parseJson(registryText())};
  return journal;
}

}
