#pragma once

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Registry.h"

#include <string_view>

namespace wm::probe {

// packages/api-contract/sync/probe.registry.json, the test-only product the corpus is written against,
// embedded into the test binary at build time (CMakeLists.txt, wm_embed_registry).
std::string_view registryText();

inline const sync::Registry& registry() {
  static const sync::Registry probe{sync::parseJson(registryText())};
  return probe;
}

}
