#include "platform/adapters/mcp/CompositeToolHost.h"

#include "test/testing.h"

#include <algorithm>
#include <stdexcept>
#include <string>
#include <vector>

using namespace wm;

namespace {

struct FakeProduct : ToolHost {
  struct Call {
    std::string name;
    Json::Value args;
    std::string caller;
  };

  std::string product;
  std::vector<ToolDeclaration> catalog;
  std::vector<ToolRetirement> retired;
  std::vector<Call> calls;

  explicit FakeProduct(std::string named) : product(std::move(named)) {}

  void declare(const char* name, Access access, std::vector<const char*> properties) {
    Json::Value props(Json::objectValue);
    for (const char* property : properties) props[property] = Json::Value(Json::objectValue);
    Json::Value schema(Json::objectValue);
    schema["type"] = "object";
    schema["properties"] = props;
    schema["additionalProperties"] = false;

    Json::Value descriptor(Json::objectValue);
    descriptor["name"] = name;
    descriptor["description"] = std::string("the ") + name + " tool";
    descriptor["inputSchema"] = schema;
    catalog.push_back(ToolDeclaration{descriptor, product, access});
  }

  std::vector<ToolDeclaration> declareTools() const override { return catalog; }
  std::vector<ToolRetirement> retiredTools() const override { return retired; }

  ToolResult callTool(const std::string& name, const Json::Value& arguments,
                      const ToolCaller& caller) override {
    calls.push_back({name, arguments, caller.user.str()});
    Json::Value out(Json::objectValue);
    out["ran"] = name;
    return ToolResult::json(out);
  }
};

FakeProduct roadmap() {
  FakeProduct product("roadmap");
  product.declare("get_tree", Access::read, {"treeId"});
  product.declare("create_node", Access::write, {"treeId", "label"});
  product.declare("delete_node", Access::del, {"treeId", "nodeId"});
  return product;
}

FakeProduct gym() {
  FakeProduct product("gym");
  product.declare("list_sessions", Access::read, {"limit"});
  product.declare("log_set", Access::write, {"sessionId", "reps"});
  product.declare("delete_session", Access::del, {"sessionId"});
  return product;
}

std::vector<std::string> namesIn(const Json::Value& tools) {
  std::vector<std::string> names;
  for (const Json::Value& tool : tools) names.push_back(tool["name"].asString());
  return names;
}

ToolCaller granted(const char* scope) { return ToolCaller{UserId{"u1"}, parseToolScope(scope)}; }

std::string message(const ToolResult& result) { return result.content[0]["text"].asString(); }

Json::Value args(std::vector<std::pair<const char*, const char*>> fields) {
  Json::Value out(Json::objectValue);
  for (const auto& field : fields) out[field.first] = field.second;
  return out;
}

}

TEST(composite_lists_every_connected_product_to_an_account_wide_grant) {
  FakeProduct r = roadmap();
  FakeProduct g = gym();
  CompositeToolHost surface(std::vector<ToolModule>{{r, "roadmap paragraph"}, {g, "gym paragraph"}});

  CHECK_EQ(namesIn(surface.listTools(granted(""))),
           (std::vector<std::string>{"get_tree", "create_node", "delete_node", "list_sessions",
                                     "log_set", "delete_session"}));
  CHECK_EQ(surface.products(), (std::vector<std::string>{"roadmap", "gym"}));
}

TEST(composite_shows_a_grant_only_the_products_it_names) {
  FakeProduct r = roadmap();
  FakeProduct g = gym();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}, {g, ""}});

  CHECK_EQ(namesIn(surface.listTools(granted("gym:read gym:write"))),
           (std::vector<std::string>{"list_sessions", "log_set"}));
}

TEST(composite_hides_a_delete_tool_from_a_grant_that_did_not_name_delete) {
  FakeProduct g = gym();
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  const std::vector<std::string> readWrite = namesIn(surface.listTools(granted("gym:read gym:write")));
  CHECK_EQ(readWrite, (std::vector<std::string>{"list_sessions", "log_set"}));
  CHECK_EQ(namesIn(surface.listTools(granted("gym:read gym:write gym:delete"))),
           (std::vector<std::string>{"list_sessions", "log_set", "delete_session"}));
}

TEST(composite_refuses_an_out_of_scope_tool_before_the_product_sees_it) {
  FakeProduct g = gym();
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  const ToolResult refused =
      surface.callTool("delete_session", args({{"sessionId", "s1"}}), granted("gym:read gym:write"));
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("delete_session: this connection was not granted gym:delete, so it cannot run "
                       "this tool. Reconnect and approve that level."));
  CHECK_EQ(g.calls.size(), std::size_t{0});
}

TEST(composite_runs_a_tool_the_grant_covers_and_passes_the_caller_through) {
  FakeProduct g = gym();
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  const ToolResult ran = surface.callTool("log_set", args({{"sessionId", "s1"}, {"reps", "5"}}),
                                          granted("gym:write"));
  CHECK_FALSE(ran.isError);
  REQUIRE_EQ(g.calls.size(), std::size_t{1});
  CHECK_EQ(g.calls[0].name, std::string("log_set"));
  CHECK_EQ(g.calls[0].caller, std::string("u1"));
  CHECK_EQ(g.calls[0].args["reps"].asString(), std::string("5"));
}

TEST(composite_routes_each_name_to_the_product_that_declared_it) {
  FakeProduct r = roadmap();
  FakeProduct g = gym();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}, {g, ""}});

  surface.callTool("get_tree", args({{"treeId", "t"}}), granted(""));
  surface.callTool("list_sessions", Json::Value(Json::objectValue), granted(""));
  REQUIRE_EQ(r.calls.size(), std::size_t{1});
  REQUIRE_EQ(g.calls.size(), std::size_t{1});
  CHECK_EQ(r.calls[0].name, std::string("get_tree"));
  CHECK_EQ(g.calls[0].name, std::string("list_sessions"));
}

TEST(composite_owns_the_whole_server_answer_for_a_name_nothing_declared) {
  FakeProduct r = roadmap();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  const ToolResult missing = surface.callTool("frobnicate", Json::Value(Json::objectValue), granted(""));
  CHECK(missing.isError);
  CHECK_EQ(message(missing),
           std::string("frobnicate: no such tool on this server — call tools/list for the whole surface."));
  CHECK_EQ(r.calls.size(), std::size_t{0});
}

// The composite resolves names against the catalogs it was built from, so a retired name answers with the product's own sentence.
TEST(composite_answers_a_retired_name_with_the_products_sentence_and_never_calls_it) {
  FakeProduct g = gym();
  g.retired.push_back(ToolRetirement{"save_routine", "log_set",
                                     "retired on 2026-08-12. Use log_set instead."});
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  const ToolResult retired =
      surface.callTool("save_routine", args({{"routineId", "r1"}}), granted("gym:read"));
  CHECK(retired.isError);
  CHECK_EQ(message(retired), std::string("save_routine: retired on 2026-08-12. Use log_set instead."));
  CHECK_EQ(g.calls.size(), std::size_t{0});
  CHECK_EQ(namesIn(surface.listTools(granted(""))),
           (std::vector<std::string>{"list_sessions", "log_set", "delete_session"}));
  CHECK_EQ(message(surface.callTool("frobnicate", Json::Value(Json::objectValue), granted(""))),
           std::string("frobnicate: no such tool on this server — call tools/list for the whole surface."));
  const std::vector<ToolRetirement> all = surface.retiredTools();
  REQUIRE_EQ(all.size(), std::size_t{1});
  CHECK_EQ(all[0].name, std::string("save_routine"));
  CHECK_EQ(all[0].replacement, std::string("log_set"));
  CHECK_EQ(all[0].sentence, std::string("retired on 2026-08-12. Use log_set instead."));
}

TEST(composite_refuses_to_construct_when_a_retired_name_is_a_live_tool_of_any_module) {
  FakeProduct r = roadmap();
  FakeProduct g = gym();
  g.retired.push_back(ToolRetirement{"get_tree", "list_sessions", "retired."});

  bool threw = false;
  std::string detail;
  try {
    CompositeToolHost surface(std::vector<ToolModule>{{r, ""}, {g, ""}});
  } catch (const std::invalid_argument& error) {
    threw = true;
    detail = error.what();
  }
  CHECK(threw);
  CHECK_EQ(detail, std::string("the MCP tool \"get_tree\" is declared by roadmap and retired at the same "
                               "time — a retired name must never shadow a live one"));
}

TEST(composite_refuses_to_construct_when_a_replacement_is_not_a_live_tool) {
  FakeProduct g = gym();
  g.retired.push_back(ToolRetirement{"save_routine", "propose_routine_change", "retired."});

  bool threw = false;
  std::string detail;
  try {
    CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});
  } catch (const std::invalid_argument& error) {
    threw = true;
    detail = error.what();
  }
  CHECK(threw);
  CHECK_EQ(detail, std::string("the retired MCP tool \"save_routine\" names \"propose_routine_change\" "
                               "as its replacement, and no product declares that tool"));
}

TEST(composite_accepts_a_retirement_with_no_replacement) {
  FakeProduct g = gym();
  g.retired.push_back(ToolRetirement{"get_preferences", "", "retired, and nothing replaced it."});
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  const ToolResult retired =
      surface.callTool("get_preferences", Json::Value(Json::objectValue), granted(""));
  CHECK(retired.isError);
  CHECK_EQ(message(retired), std::string("get_preferences: retired, and nothing replaced it."));
  CHECK_EQ(g.calls.size(), std::size_t{0});
}

TEST(composite_refuses_to_construct_when_two_products_declare_one_name) {
  FakeProduct r = roadmap();
  FakeProduct g = gym();
  g.declare("get_tree", Access::read, {"treeId"});

  bool threw = false;
  std::string detail;
  try {
    CompositeToolHost surface(std::vector<ToolModule>{{r, ""}, {g, ""}});
  } catch (const std::invalid_argument& error) {
    threw = true;
    detail = error.what();
  }
  CHECK(threw);
  CHECK_EQ(detail, std::string("two products declare the MCP tool \"get_tree\": roadmap and gym — one "
                               "name must answer for exactly one product"));
}

TEST(composite_refuses_an_argument_no_schema_declares_and_names_it) {
  FakeProduct r = roadmap();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  Json::Value withStrayKey = args({{"treeId", "t"}, {"label", "Step"}});
  withStrayKey["edges"] = Json::Value(Json::arrayValue);
  const ToolResult refused = surface.callTool("create_node", withStrayKey, granted(""));
  CHECK(refused.isError);
  CHECK_EQ(message(refused),
           std::string("create_node: unknown argument \"edges\". This tool takes: label, treeId."));
  CHECK_EQ(r.calls.size(), std::size_t{0});
}

TEST(composite_lets_every_declared_argument_through_untouched) {
  FakeProduct r = roadmap();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  const ToolResult ran = surface.callTool("create_node", args({{"treeId", "t"}, {"label", "Step"}}),
                                          granted(""));
  CHECK_FALSE(ran.isError);
  REQUIRE_EQ(r.calls.size(), std::size_t{1});
  CHECK_EQ(r.calls[0].args["label"].asString(), std::string("Step"));
}

TEST(composite_checks_the_grant_before_the_schema) {
  FakeProduct g = gym();
  CompositeToolHost surface(std::vector<ToolModule>{{g, ""}});

  Json::Value bad(Json::objectValue);
  bad["nonsense"] = 1;
  const ToolResult refused = surface.callTool("delete_session", bad, granted("gym:read"));
  CHECK(refused.isError);
  CHECK(message(refused).find("was not granted gym:delete") != std::string::npos);
}

TEST(windmill_server_info_names_the_connected_products_and_carries_their_paragraphs) {
  FakeProduct r = roadmap();
  FakeProduct g = gym();
  CompositeToolHost surface(std::vector<ToolModule>{{r, "Roadmaps are skill trees."}, {g, "A gym log."}});

  const ServerInfo info = windmillServerInfo(surface);
  CHECK_EQ(info.name, std::string("windmill"));
  CHECK(info.instructions.find("This connection reaches: roadmap, gym.") != std::string::npos);
  CHECK(info.instructions.find("a tool you cannot see is a level that was not granted") !=
        std::string::npos);
  CHECK(info.instructions.find("Roadmaps are skill trees.") != std::string::npos);
  CHECK(info.instructions.find("A gym log.") != std::string::npos);
  CHECK_EQ(info.version, std::string("0.1.0"));
  CHECK(info.instructions.find("build") == std::string::npos);
}

// The handshake dates the catalog — the deployed sha as semver build metadata plus one sentence saying what a stale list means.
TEST(windmill_server_info_dates_the_catalog_with_the_deployed_build) {
  FakeProduct r = roadmap();
  CompositeToolHost surface(std::vector<ToolModule>{{r, ""}});

  const ServerInfo info = windmillServerInfo(surface, "e86762e0d1c2b3a4f5");
  CHECK_EQ(info.version, std::string("0.1.0+e86762e"));
  CHECK(info.instructions.find("This server is build e86762e;") != std::string::npos);
  CHECK(info.instructions.find("reconnect rather than concluding the server is old") !=
        std::string::npos);
}
