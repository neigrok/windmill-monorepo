#pragma once

#include "platform/ports/ToolHost.h"

#include <string>
#include <string_view>
#include <vector>

namespace wm::gym {

// Shared by the schemas that advertise them and the domain that refuses against them.
inline const std::vector<const char*> kPatterns = {"squat", "hinge", "press",
                                                   "pull",  "carry", "core", "isolation"};
inline const std::vector<const char*> kEquipment = {"barbell", "dumbbell",   "machine",
                                                    "cable",   "bodyweight", "kettlebell", "other"};
inline const std::vector<const char*> kSetKinds = {"warmup", "working", "drop", "failure"};

constexpr std::size_t kMaxBatchReadIds = 50;
constexpr std::size_t kBatchReadByteBudget = 256 * 1024;

constexpr int kDefaultLogLimit = 20;
constexpr int kMaxLogLimit = 200;

// The prefix is the grant: any `propose_*` tool, at any access level, is reachable by Ask.
inline bool mintsProposal(const std::string& toolName) {
  return toolName.rfind("propose_", 0) == 0;
}

// Every tool, its sentence, the JSON Schema its arguments are pre-validated against, and the grant
// level that reaches it.
std::vector<ToolDeclaration> gymToolCatalog();

// packages/api-contract/gym/catalog.json as this binary embeds it: the catalog of record the declarations
// above are pinned to.
std::string_view catalogText();

std::string gymInstructions();

}
