#pragma once

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Registry.h"

#include <string_view>

namespace wm::gym::engine {

std::string_view registryText();
std::string_view compositionText();

inline const sync::Registry& registry() {
  static const sync::Registry gym{sync::parseJson(registryText())};
  return gym;
}

}
