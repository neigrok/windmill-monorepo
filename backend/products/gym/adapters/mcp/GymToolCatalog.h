#pragma once

#include "platform/ports/ToolHost.h"

#include <string>
#include <vector>

namespace wm::gym {

// Shared by the schemas that advertise them and the domain that refuses against them.
inline const std::vector<const char*> kPatterns = {"squat", "hinge", "press",
                                                   "pull",  "carry", "core", "isolation"};
inline const std::vector<const char*> kEquipment = {"barbell", "dumbbell",   "machine",
                                                    "cable",   "bodyweight", "kettlebell"};
inline const std::vector<const char*> kSetKinds = {"warmup", "working", "drop", "failure"};

constexpr int kDefaultLogLimit = 20;
constexpr int kMaxLogLimit = 200;

// The prefix is the grant: any `propose_*` tool, at any access level, is reachable by Ask.
inline bool mintsProposal(const std::string& toolName) {
  return toolName.rfind("propose_", 0) == 0;
}

// Every tool, its sentence, the JSON Schema its arguments are pre-validated against, and the grant
// level that reaches it.
std::vector<ToolDeclaration> gymToolCatalog();

std::string gymInstructions();

}
