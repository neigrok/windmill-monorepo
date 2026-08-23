#pragma once

#include "platform/ports/ToolHost.h"

#include <string>
#include <vector>

namespace wm::gym {

// The three published vocabularies, shared by the schemas that advertise them and the domain that
// refuses against them.
inline const std::vector<const char*> kPatterns = {"squat", "hinge", "press",
                                                   "pull",  "carry", "core", "isolation"};
inline const std::vector<const char*> kEquipment = {"barbell", "dumbbell",   "machine",
                                                    "cable",   "bodyweight", "kettlebell"};
inline const std::vector<const char*> kSetKinds = {"warmup", "working", "drop", "failure"};

constexpr int kDefaultLogLimit = 20;
constexpr int kMaxLogLimit = 200;

// The tools that change nothing and hand the lifter a typed diff instead; Ask holds every read plus
// exactly these. The prefix IS the grant: any future `propose_*` tool, at any access level, joins
// what a model reachable by every account may call.
inline bool mintsProposal(const std::string& toolName) {
  return toolName.rfind("propose_", 0) == 0;
}

// Every tool, its sentence, the JSON Schema its arguments are pre-validated against, and the grant
// level that reaches it.
std::vector<ToolDeclaration> gymToolCatalog();

// Gym's paragraph in the `initialize` brief, and only the paragraph.
std::string gymInstructions();

}
