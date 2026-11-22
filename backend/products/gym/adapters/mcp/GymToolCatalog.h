#pragma once

#include "platform/ports/ToolHost.h"

#include <string>
#include <string_view>
#include <vector>

namespace wm::gym {

constexpr std::size_t kMaxBatchReadIds = 50;
constexpr std::size_t kBatchReadByteBudget = 256 * 1024;

constexpr int kDefaultLogLimit = 20;
constexpr int kMaxLogLimit = 200;

// The prefix is the grant: any `propose_*` tool, at any access level, is reachable by Ask.
inline bool mintsProposal(const std::string& toolName) {
  return toolName.rfind("propose_", 0) == 0;
}

// The open workout is the phone Coach's alone: no surface draws a card for a connected agent's workout proposal, and
// the server Coach answers only while no workout is open. GymTools declares every other tool to MCP and the server Coach.
inline bool phoneCoachOnly(const std::string& toolName) { return toolName == "propose_workout_change"; }

// The tools whose answer MCP carries as structuredContent too, held to the ability's `result` as its outputSchema.
inline bool answersStructured(const std::string& toolName) {
  return toolName == "get_sessions" || toolName == "get_last_times" || toolName == "log_sets" ||
         toolName == "import_session";
}

// packages/api-contract/gym/catalog-3.json and catalog.json as this binary embeds them. catalog/3 is the catalog of
// every door; catalog.json is catalog/2, which the turns of builds released before catalog/3 open until the cutover.
std::string_view catalog3Text();
std::string_view catalog2Text();

// Every ability a catalog file declares, as a tool: its name, sentence and input schema exactly as the file writes
// them (and its `result` as the outputSchema of a structured answer), and the grant level its class asks for — a read `read`, a removal `delete`, anything else `write`. Reads, then
// writes, then deletes, so a narrower grant sees a prefix of the list rather than one with holes in it.
std::vector<ToolDeclaration> declarationsOf(std::string_view catalogText);

// catalog/3's tools: what MCP lists and the server Coach offers.
std::vector<ToolDeclaration> gymToolCatalog();

std::string gymInstructions();

}
