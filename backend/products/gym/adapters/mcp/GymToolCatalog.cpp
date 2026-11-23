#include "products/gym/adapters/mcp/GymToolCatalog.h"

#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

namespace wm::gym {

std::vector<ToolDeclaration> declarationsOf(std::string_view catalogText) {
  std::vector<ToolDeclaration> tools;
  const Json::Value catalog = sync::parseJson(catalogText);
  for (const Json::Value& ability : catalog["abilities"]) {
    if (!ability.get("declared", true).asBool()) continue;
    const std::string name = ability["name"].asString();
    const std::string cls = ability["class"].asString();
    Json::Value descriptor(Json::objectValue);
    descriptor["name"] = name;
    descriptor["description"] = ability["description"];
    descriptor["inputSchema"] = ability["input"];
    if (answersStructured(name)) descriptor["outputSchema"] = ability["result"];
    ToolDeclaration declaration{std::move(descriptor), "gym",
                                cls == "read" ? Access::read : cls == "remove" ? Access::del : Access::write};
    // Retry identity follows each tool's caller id, proposal, session end or active share link.
    declaration.idempotent = true;
    // A removal that only proposes: the grant is delete-level, and the tool mints a card and removes nothing.
    declaration.proposal = cls == "remove" && ability["agent"] == "proposes";
    tools.push_back(std::move(declaration));
  }
  std::stable_sort(tools.begin(), tools.end(), [](const ToolDeclaration& left, const ToolDeclaration& right) {
    return left.access < right.access;
  });
  return tools;
}

// Duplicating a day is reading it with list_routines and sending it back under a fresh id. What only the read answers
// with is not declared on catalog/3's writes, where it would spend strict mode's room on nothing; every door the server
// hosts drops it unread.
std::vector<ToolDeclaration> gymToolCatalog() {
  std::vector<ToolDeclaration> tools = declarationsOf(catalog3Text());
  for (ToolDeclaration& tool : tools) {
    if (tool.name() == "create_routine")
      tool.readBack = {"revision", "lastTrainedAt", "pendingProposal", "entries[].position"};
    if (tool.name() == "propose_routine_change") tool.readBack = {"entries[].position"};
  }
  return tools;
}

std::string gymInstructions() {
  return "Gym: Coach in a friendly, informal voice. Before training decisions, including new routines, "
         "review the user's goals, constraints and app history. Reuse known answers; get missing "
         "essentials from the user before proposing or changing the plan. Make systematic changes "
         "tied to those goals and check consistency across exercises, schedule, volume, progression "
         "and constraints. Existing-routine changes are proposals: tell the user they await Apply. "
         "Log supplied workout facts without coaching intake.\n\n"
         "Retry lost replies with the same ID and body. Loads are kg; times are epoch milliseconds. "
         "Each `read` tally covers its reply; do not sum tallies across replies.";
}

}
