#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "products/roadmap/adapters/mcp/RoadmapToolCatalog.h"

#include "test/testing.h"

#include <cstddef>
#include <string>
#include <vector>

using namespace wm;

namespace {

// Every tool each product declares and the annotations its wire entry must carry. A tool missing
// from its table, or a table row no catalog declares, fails the suite: a new tool is classified here
// before it ships.
struct Row {
  const char* name;
  const char* title;
  bool readOnly;
  bool destructive;
  bool idempotent;
};

const std::vector<Row> kRoadmap = {
    {"create_tree", "Roadmap · Create tree", false, false, false},
    {"list_trees", "Roadmap · List trees", true, false, true},
    {"delete_tree", "Roadmap · Delete tree", false, true, true},
    {"get_tree", "Roadmap · Get tree", true, false, true},
    {"get_diagnostics", "Roadmap · Get diagnostics", true, false, true},
    {"get_health", "Roadmap · Get health", true, false, true},
    {"get_progress", "Roadmap · Get progress", true, false, true},
    {"find_nodes", "Roadmap · Find nodes", true, false, true},
    {"create_node", "Roadmap · Create node", false, false, false},
    {"annotate_node", "Roadmap · Annotate node", false, false, true},
    {"rename_node", "Roadmap · Rename node", false, false, true},
    {"set_node_color", "Roadmap · Set node color", false, false, true},
    {"move_node", "Roadmap · Move node", false, false, true},
    {"connect", "Roadmap · Connect", false, false, true},
    {"disconnect", "Roadmap · Disconnect", false, false, true},
    {"reconnect", "Roadmap · Reconnect", false, false, true},
    {"delete_node", "Roadmap · Delete node", false, true, true},
    {"tidy", "Roadmap · Tidy", false, true, true},
    {"add_kind", "Roadmap · Add kind", false, false, true},
    {"rename_kind", "Roadmap · Rename kind", false, false, true},
    {"describe_kind", "Roadmap · Describe kind", false, false, true},
    {"remove_kind", "Roadmap · Remove kind", false, true, true},
    {"reorder_kinds", "Roadmap · Reorder kinds", false, false, true},
    {"recolor_kind", "Roadmap · Recolor kind", false, false, true},
    {"set_progress", "Roadmap · Set progress", false, false, true},
    {"import_subgraph", "Roadmap · Import subgraph", false, true, true},
    {"prune", "Roadmap · Prune", false, true, true},
};

const std::vector<Row> kGym = {
    {"list_exercises", "Gym · List exercises", true, false, true},
    {"list_sessions", "Gym · List sessions", true, false, true},
    {"get_session", "Gym · Get session", true, false, true},
    {"last_time", "Gym · Last time", true, false, true},
    {"list_routines", "Gym · List routines", true, false, true},
    {"get_stats", "Gym · Get stats", true, false, true},
    {"list_notes", "Gym · List notes", true, false, true},
    {"list_bodyweight", "Gym · List bodyweight", true, false, true},
    {"start_session", "Gym · Start session", false, false, true},
    {"log_set", "Gym · Log set", false, false, true},
    {"finish_session", "Gym · Finish session", false, false, true},
    {"create_routine", "Gym · Create routine", false, false, true},
    {"propose_routine_change", "Gym · Propose routine change", false, false, true},
    {"create_exercise", "Gym · Create exercise", false, false, true},
    {"share_session", "Gym · Share session", false, false, true},
    {"discard_session", "Gym · Discard session", false, true, true},
    {"propose_routine_removal", "Gym · Propose routine removal", false, true, true},
    {"revoke_share", "Gym · Revoke share", false, true, true},
};

Json::Value expectedAnnotations(const Row& row) {
  Json::Value out(Json::objectValue);
  out["title"] = row.title;
  out["readOnlyHint"] = row.readOnly;
  out["destructiveHint"] = row.destructive;
  out["idempotentHint"] = row.idempotent;
  out["openWorldHint"] = false;
  return out;
}

std::vector<std::string> names(const std::vector<Row>& rows) {
  std::vector<std::string> out;
  for (const Row& row : rows) out.push_back(row.name);
  return out;
}

std::vector<std::string> names(const std::vector<ToolDeclaration>& catalog) {
  std::vector<std::string> out;
  for (const ToolDeclaration& tool : catalog) out.push_back(tool.name());
  return out;
}

void checkCatalog(const std::vector<ToolDeclaration>& catalog, const std::vector<Row>& table,
                  const char* product, const char* productWord) {
  REQUIRE_EQ(names(catalog), names(table));
  for (std::size_t i = 0; i < catalog.size(); ++i) {
    const ToolDeclaration& declared = catalog[i];
    const Json::Value wire = declared.wire();
    CHECK_EQ(wire["name"].asString(), std::string(table[i].name));
    CHECK_EQ(wire["title"].asString(), std::string(table[i].title));
    CHECK_EQ(wire["annotations"], expectedAnnotations(table[i]));
    CHECK_EQ(wire["description"], declared.descriptor["description"]);
    CHECK_EQ(wire["inputSchema"], declared.descriptor["inputSchema"]);
    CHECK_EQ(wire["_meta"]["product"].asString(), declared.product);
    CHECK_EQ(wire["_meta"]["product"].asString(), std::string(product));
    CHECK_EQ(wire["_meta"]["access"].asString(), toString(declared.access));
    CHECK_EQ(wire["_meta"].getMemberNames(), (std::vector<std::string>{"access", "product"}));

    // The rules the table is written by, checked against the declaration itself.
    CHECK_EQ(wire["annotations"]["readOnlyHint"].asBool(), declared.access == Access::read);
    if (declared.access == Access::del) CHECK(wire["annotations"]["destructiveHint"].asBool());
    if (declared.bulkEdit) CHECK(wire["annotations"]["destructiveHint"].asBool());
    if (declared.access == Access::read) CHECK(wire["annotations"]["idempotentHint"].asBool());
    CHECK_EQ(wire["title"].asString().rfind(std::string(productWord) + " · ", 0), std::size_t{0});
  }
}

}  // namespace

TEST(every_roadmap_tool_carries_the_annotations_its_declaration_derives) {
  checkCatalog(roadmapToolCatalog(), kRoadmap, "roadmap", "Roadmap");
}

TEST(every_gym_tool_carries_the_annotations_its_declaration_derives) {
  checkCatalog(gym::gymToolCatalog(), kGym, "gym", "Gym");
}

TEST(only_the_allowlisted_roadmap_writes_are_bulk_edits) {
  std::vector<std::string> bulk;
  for (const ToolDeclaration& tool : roadmapToolCatalog())
    if (tool.bulkEdit) bulk.push_back(tool.name());
  CHECK_EQ(bulk, (std::vector<std::string>{"tidy", "import_subgraph", "prune"}));
  for (const ToolDeclaration& tool : gym::gymToolCatalog()) CHECK_FALSE(tool.bulkEdit);
}
