#pragma once

#include "platform/domain/sync/Jcs.h"
#include "platform/domain/sync/Registry.h"

#include <string_view>

namespace wm::probe {

// packages/api-contract/sync/probe.registry.json, embedded at build time (CMakeLists.txt, wm_embed_registry):
// the product the golden corpus is written against. Only the test binaries and windmill_server_probe link
// it; windmill_server never does.
std::string_view registryText();

inline const sync::Registry& registry() {
  static const sync::Registry probe{sync::parseJson(registryText())};
  return probe;
}

}
