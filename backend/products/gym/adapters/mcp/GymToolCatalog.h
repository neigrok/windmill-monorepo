#pragma once

#include "platform/ports/ToolHost.h"

#include <string>
#include <vector>

namespace wm::gym {

// The three published vocabularies, shared by the schemas that advertise them and the domain that
// refuses against them (parsePattern / parseEquipment / parseSetKind, domain/Training.h).
// GymToolsTest round-trips every word here through the domain.
inline const std::vector<const char*> kPatterns = {"squat", "hinge", "press",
                                                   "pull",  "carry", "core", "isolation"};
inline const std::vector<const char*> kEquipment = {"barbell", "dumbbell",   "machine",
                                                    "cable",   "bodyweight", "kettlebell"};
inline const std::vector<const char*> kSetKinds = {"warmup", "working", "drop", "failure"};

// What a page of the log costs an agent. The REST reader is a screen and takes 50; a tool reply is
// context, and an agent that wants more says so.
constexpr int kDefaultLogLimit = 20;
constexpr int kMaxLogLimit = 200;

// The tools that CHANGE NOTHING and hand the lifter a typed diff instead. The NAME is the contract:
// `propose_` says this call lands nothing and waits for a tap. Ask holds every read plus exactly
// these.
// A PREFIX IS A GRANT THAT COULD GROW BY NAMING: any future `propose_*` tool, at any access level,
// joins what a model reachable by every account may call. `AskServiceTest` asserts Ask's offered
// names literally, so adding one fails a test.
inline bool mintsProposal(const std::string& toolName) {
  return toolName.rfind("propose_", 0) == 0;
}

// What gym advertises to an agent: every tool, its sentence, the JSON Schema its arguments are
// pre-validated against, and the grant level that reaches it. No service and no caller — the
// dispatch that keeps the promise is GymTools.cpp.
std::vector<ToolDeclaration> gymToolCatalog();

// Gym's paragraph in the `initialize` brief, and only the paragraph: the server's name and the
// sentence about what a short tools/list means belong to windmillServerInfo.
std::string gymInstructions();

}
