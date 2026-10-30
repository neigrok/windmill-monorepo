#include "products/gym/adapters/mcp/GymToolCatalog.h"

#include "platform/domain/sync/Jcs.h"
#include "products/gym/coach/AbilityCatalog.h"
#include "test/testing.h"

#include <map>
#include <functional>
#include <set>
#include <string>
#include <vector>

// packages/api-contract/gym/catalog.json is the catalog of record (gym_coach.md D-2, §3.1); the server's tool
// declarations are pinned to it byte for byte.
using namespace wm;
using namespace wm::gym;

namespace {

const Json::Value& catalog() {
  static const Json::Value parsed = sync::parseJson(catalogText());
  return parsed;
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

TEST(gym_catalog_json_is_catalog_2_and_every_ability_carries_exactly_the_declared_fields) {
  REQUIRE_EQ(catalog()["catalog"].asString(), std::string("catalog/2"));
  REQUIRE(catalog()["abilities"].isArray());
  const std::set<std::string> fields{"name", "description", "input", "result", "class", "agent", "seats", "phrase", "ui"};
  std::set<std::string> names;
  for (const Json::Value& ability : catalog()["abilities"]) {
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
    CHECK(carried == fields);
    CHECK(names.insert(ability["name"].asString()).second);
    CHECK((std::set<std::string>{"read", "add", "change", "remove"}.contains(ability["class"].asString())));
    CHECK((std::set<std::string>{"runs", "proposes", "withheld"}.contains(ability["agent"].asString())));
    CHECK((std::set<std::string>{"any", "bound"}.contains(ability["seats"].asString())));
    CHECK(!ability["phrase"].asString().empty() && !ability["phrase"].asString().ends_with('.'));
    CHECK(!ability["ui"].asString().empty());
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
  for (const auto& ability : catalog()["abilities"]) collect(ability["result"]);
  CHECK_EQ(metrics.size(), std::size_t(11));
  const auto expected = sync::parseJson(R"({"type":["number","null"]})");
  for (const auto& schema : metrics) {
    CHECK_EQ(schema, expected);
    CHECK_FALSE(coach::schemaViolation(schema, Json::Value()).has_value());
    CHECK_FALSE(coach::schemaViolation(schema, Json::Value(123.45)).has_value());
    CHECK(coach::schemaViolation(schema, Json::Value("unavailable")).has_value());
  }
}

// MCP keeps working because each tool's name, description and input schema ARE the catalog's, compared as JCS.
TEST(gym_catalog_json_declares_every_server_tool_byte_for_byte) {
  std::map<std::string, Json::Value> abilities = declaredAbilities();
  std::set<std::string> undeclared;
  for (const Json::Value& ability : catalog()["abilities"])
    if (!ability.get("declared", true).asBool()) undeclared.insert(ability["name"].asString());

  for (const ToolDeclaration& tool : gymToolCatalog()) {
    CHECK_FALSE(undeclared.contains(tool.name()));
    const auto ability = abilities.find(tool.name());
    if (ability == abilities.end()) {
      ::testing::fail(("no catalog.json ability for the server tool " + tool.name()).c_str(), __FILE__, __LINE__);
      continue;
    }
    Json::Value pinned(Json::objectValue);
    pinned["name"] = ability->second["name"];
    pinned["description"] = ability->second["description"];
    pinned["inputSchema"] = ability->second["input"];
    Json::Value declared(Json::objectValue);
    for (const char* field : {"name", "description", "inputSchema"}) declared[field] = tool.descriptor[field];
    if (sync::jcs(pinned) != sync::jcs(declared))
      ::testing::fail(("catalog.json drifts from the server's " + tool.name() + "; it declares " + sync::jcs(declared)).c_str(),
                      __FILE__, __LINE__);
    abilities.erase(ability);
  }
  for (const auto& [name, ability] : abilities)
    ::testing::fail(("catalog.json declares " + name + ", which the server does not; mark it \"declared\": false").c_str(),
                    __FILE__, __LINE__);
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

// §3.1 closes `input` at every depth, and this corpus's results likewise. Three object schemas in two server tools
// predate the rule and stay open; they are pinned here, so a new one fails.
TEST(gym_catalog_json_closes_every_object_schema_at_every_depth) {
  const std::map<std::string, std::vector<std::string>> openInputs{
      {"create_routine", {"/properties/entries/items/properties/sets/items", "/properties/pendingProposal"}},
      {"propose_routine_change", {"/properties/entries/items/properties/sets/items"}}};
  for (const Json::Value& ability : catalog()["abilities"]) {
    const std::string name = ability["name"].asString();
    const auto known = openInputs.find(name);
    CHECK(openObjects(ability["input"]) == (known == openInputs.end() ? std::vector<std::string>{} : known->second));
    CHECK(openObjects(ability["result"]).empty());
    CHECK_EQ(ability["input"]["type"].asString(), std::string("object"));
  }
}
