#include "products/gym/adapters/mcp/GymToolCatalog.h"

#include "platform/domain/sync/Jcs.h"
#include "products/gym/coach/AbilityCatalog.h"
#include "test/testing.h"

#include <map>
#include <functional>
#include <set>
#include <string>
#include <utility>
#include <vector>

// packages/api-contract/gym/catalog-3.json is the catalog of every door (gym-coach-on-ai-service.md §3, R-11), and MCP
// lists its tools byte for byte; catalog.json is catalog/2, which released builds open turns with until the cutover.
using namespace wm;
using namespace wm::gym;

namespace {

const Json::Value& catalog() {
  static const Json::Value parsed = sync::parseJson(catalog3Text());
  return parsed;
}

// Both files the server serves, each with the version it names.
std::vector<std::pair<std::string, Json::Value>> servedFiles() {
  return {{"catalog/2", sync::parseJson(catalog2Text())}, {"catalog/3", catalog()}};
}

// The abilities the server declares a tool for: every entry but those marked `"declared": false`.
std::map<std::string, Json::Value> declaredAbilities() {
  std::map<std::string, Json::Value> abilities;
  for (const Json::Value& ability : catalog()["abilities"])
    if (ability.get("declared", true).asBool()) abilities.emplace(ability["name"].asString(), ability);
  return abilities;
}

// Every object schema under `schema` that leaves itself open, by JSON pointer: no `additionalProperties: false`, or
// no `required` list.
void collectOpenObjects(const Json::Value& schema, const std::string& path, std::vector<std::string>& open) {
  if (!schema.isObject()) return;
  if (schema["type"] == "object") {
    if (schema["additionalProperties"] != Json::Value(false) || !schema["required"].isArray()) open.push_back(path);
    for (const std::string& name : schema["properties"].getMemberNames())
      collectOpenObjects(schema["properties"][name], path + "/properties/" + name, open);
  }
  if (schema.isMember("items")) collectOpenObjects(schema["items"], path + "/items", open);
}

std::vector<std::string> openObjects(const Json::Value& schema) {
  std::vector<std::string> open;
  collectOpenObjects(schema, "", open);
  return open;
}

}

TEST(gym_catalog_files_name_their_version_and_every_ability_carries_exactly_the_declared_fields) {
  for (const auto& [version, file] : servedFiles()) {
    REQUIRE_EQ(file["catalog"].asString(), version);
    REQUIRE(file["abilities"].isArray());
    const std::set<std::string> fields{"name", "description", "input", "result", "class", "agent", "seats", "phrase", "ui"};
    std::set<std::string> names;
    for (const Json::Value& ability : file["abilities"]) {
      std::set<std::string> carried;
      for (const std::string& field : ability.getMemberNames()) carried.insert(field);
      if (ability.isMember("declared")) {
        CHECK(ability["declared"] == Json::Value(false));
        carried.erase("declared");
      }
      if (ability.isMember("since")) {
        CHECK(ability["since"] == Json::Value("catalog/2"));
        carried.erase("since");
      }
      // Whether a device turn declares the tool strict to the provider: catalog/3's word, every ability's.
      CHECK_EQ(ability.isMember("strict"), version == "catalog/3");
      if (ability.isMember("strict")) {
        CHECK(ability["strict"].isBool());
        carried.erase("strict");
      }
      CHECK(carried == fields);
      CHECK(names.insert(ability["name"].asString()).second);
      CHECK((std::set<std::string>{"read", "add", "change", "remove"}.contains(ability["class"].asString())));
      CHECK((std::set<std::string>{"runs", "proposes", "withheld"}.contains(ability["agent"].asString())));
      CHECK((std::set<std::string>{"any", "bound"}.contains(ability["seats"].asString())));
      CHECK(!ability["phrase"].asString().empty() && !ability["phrase"].asString().ends_with('.'));
      CHECK(!ability["ui"].asString().empty());
    }
  }
}

TEST(gym_catalog_derived_result_metrics_admit_explicit_null) {
  std::vector<Json::Value> metrics;
  std::function<void(const Json::Value&)> collect = [&](const Json::Value& schema) {
    if (schema.isArray()) {
      for (const auto& item : schema) collect(item);
      return;
    }
    if (!schema.isObject()) return;
    for (const auto& key : schema.getMemberNames()) {
      if (key == "tonnageKg" || key == "volumeKg" || key == "topE1rm" || key == "e1rm") metrics.push_back(schema[key]);
      collect(schema[key]);
    }
  };
  for (const auto& [version, file] : servedFiles())
    for (const auto& ability : file["abilities"]) collect(ability["result"]);
  CHECK_EQ(metrics.size(), std::size_t(22));
  const auto expected = sync::parseJson(R"({"type":["number","null"]})");
  for (const auto& schema : metrics) {
    CHECK_EQ(schema, expected);
    CHECK_FALSE(coach::schemaViolation(schema, Json::Value()).has_value());
    CHECK_FALSE(coach::schemaViolation(schema, Json::Value(123.45)).has_value());
    CHECK(coach::schemaViolation(schema, Json::Value("unavailable")).has_value());
  }
}

// MCP lists catalog/3: each tool's name, description and input schema ARE the file's, compared as JCS on the wire, and a
// structured answer's outputSchema is the ability's `result`.
TEST(gym_catalog_3_is_what_mcp_lists_byte_for_byte) {
  std::map<std::string, Json::Value> abilities = declaredAbilities();
  for (const ToolDeclaration& tool : gymToolCatalog()) {
    const auto ability = abilities.find(tool.name());
    if (ability == abilities.end()) {
      ::testing::fail(("no catalog-3.json ability for the server tool " + tool.name()).c_str(), __FILE__, __LINE__);
      continue;
    }
    Json::Value pinned(Json::objectValue);
    pinned["name"] = ability->second["name"];
    pinned["description"] = ability->second["description"];
    pinned["inputSchema"] = ability->second["input"];
    if (answersStructured(tool.name())) pinned["outputSchema"] = ability->second["result"];
    const Json::Value wire = tool.wire();
    Json::Value listed(Json::objectValue);
    for (const char* field : {"name", "description", "inputSchema", "outputSchema"})
      if (wire.isMember(field)) listed[field] = wire[field];
    if (sync::jcs(pinned) != sync::jcs(listed))
      ::testing::fail(("MCP lists " + tool.name() + " apart from catalog-3.json: " + sync::jcs(listed)).c_str(), __FILE__, __LINE__);
    abilities.erase(ability);
  }
  for (const auto& [name, ability] : abilities)
    ::testing::fail(("catalog-3.json declares " + name + ", which the server does not list").c_str(), __FILE__, __LINE__);
}

// The two files hold one set of abilities, each of one class, agent rule and seats, and say the same of what each
// returns: catalog/3 moved only inputs, and says which tools a device turn declares strict.
TEST(gym_catalog_2_and_catalog_3_differ_only_in_what_they_take) {
  const Json::Value second = sync::parseJson(catalog2Text());
  REQUIRE_EQ(second["abilities"].size(), catalog()["abilities"].size());
  for (Json::ArrayIndex i = 0; i < second["abilities"].size(); ++i) {
    Json::Value older = second["abilities"][i];
    Json::Value newer = catalog()["abilities"][i];
    for (const char* moved : {"input", "description"}) {
      older.removeMember(moved);
      newer.removeMember(moved);
    }
    newer.removeMember("strict");
    CHECK_EQ(sync::jcs(older), sync::jcs(newer));
  }
}

// A read is a `read`-level tool, a removal a `delete`-level one, and only a `propose_*` tool proposes (INV-6, INV-7).
TEST(gym_catalog_json_class_and_agent_agree_with_each_tool_grant_level) {
  const std::map<std::string, Json::Value> abilities = declaredAbilities();
  for (const ToolDeclaration& tool : gymToolCatalog()) {
    const auto found = abilities.find(tool.name());
    REQUIRE(found != abilities.end());
    const std::string klass = found->second["class"].asString();
    const std::string agent = found->second["agent"].asString();
    CHECK_EQ(klass == "read", tool.access == Access::read);
    CHECK_EQ(klass == "remove", tool.access == Access::del);
    CHECK_EQ(agent == "proposes", mintsProposal(tool.name()));
    if (tool.proposal) CHECK_EQ(agent, std::string("proposes"));
    if (klass == "read") CHECK_EQ(agent, std::string("runs"));
  }
}

// Strict mode closes every object catalog/3 takes or returns, at every depth.
TEST(gym_catalog_3_closes_every_object_schema_at_every_depth) {
  for (const Json::Value& ability : catalog()["abilities"]) {
    CHECK(openObjects(ability["input"]).empty());
    CHECK(openObjects(ability["result"]).empty());
    CHECK_EQ(ability["input"]["type"].asString(), std::string("object"));
  }
}
