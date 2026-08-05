#include "platform/adapters/mcp/McpServer.h"

#include "test/testing.h"

using namespace wm;

namespace {

struct FakeHost : ToolHost {
  std::string lastName;
  Json::Value lastArgs;
  bool declaresOutputSchema = false;  // the one thing structuredContent exists to accompany

  Json::Value listTools() const override {
    Json::Value tools(Json::arrayValue);
    Json::Value one(Json::objectValue);
    one["name"] = "echo";
    tools.append(one);
    return tools;
  }

  ToolResult callTool(const std::string& name, const Json::Value& arguments, const UserId&) override {
    lastName = name;
    lastArgs = arguments;
    if (name == "boom") return ToolResult::failure("boom failed");
    Json::Value out(Json::objectValue);
    out["ok"] = true;
    ToolResult result = ToolResult::json(out);
    if (declaresOutputSchema) result.structured = out;
    return result;
  }
};

Json::Value request(const char* method, Json::Value params, Json::Value id) {
  Json::Value message(Json::objectValue);
  message["jsonrpc"] = "2.0";
  message["method"] = method;
  if (!params.isNull()) message["params"] = params;
  if (!id.isNull()) message["id"] = id;  // a notification has no id member
  return message;
}

// A neutral fixture catalog: the engine test proves the resources protocol without depending on any
// product's content (the roadmap quickstart is tested against the real tools in ToolErrorContractTest).
std::vector<McpResource> fixtureCatalog() {
  return {{"test://doc", "doc", "Test document", "a fixture resource for the engine test",
           "text/markdown", "FIXTURE BODY"}};
}

McpServer make(FakeHost& host) {
  return McpServer(host, ServerInfo{"windmill", "0.1.0", "roadmaps as skill trees"}, fixtureCatalog());
}

}

TEST(mcp_initialize_reports_capabilities_and_echoes_protocol) {
  FakeHost host;
  McpServer server = make(host);

  Json::Value params(Json::objectValue);
  params["protocolVersion"] = "2025-06-18";
  std::optional<Json::Value> reply = server.handle(request("initialize", params, 1));

  REQUIRE(reply.has_value());
  CHECK_EQ((*reply)["id"].asInt(), 1);
  CHECK_EQ((*reply)["result"]["protocolVersion"].asString(), std::string("2025-06-18"));
  CHECK_EQ((*reply)["result"]["serverInfo"]["name"].asString(), std::string("windmill"));
  CHECK(( *reply)["result"]["capabilities"].isMember("tools"));
  // Resources are declared, or a client never asks for the quickstart it could have read.
  CHECK(( *reply)["result"]["capabilities"].isMember("resources"));
  CHECK_FALSE((*reply)["result"]["capabilities"]["resources"]["subscribe"].asBool());
  CHECK_FALSE((*reply)["result"]["capabilities"]["resources"]["listChanged"].asBool());
  CHECK_EQ((*reply)["result"]["instructions"].asString(), std::string("roadmaps as skill trees"));
}

TEST(mcp_resources_list_publishes_the_injected_catalog) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(request("resources/list", Json::nullValue, 8));

  REQUIRE(reply.has_value());
  const Json::Value listing = (*reply)["result"]["resources"];
  CHECK_EQ(listing.size(), 1u);
  CHECK_EQ(listing[0]["uri"].asString(), std::string("test://doc"));
  CHECK_EQ(listing[0]["name"].asString(), std::string("doc"));
  CHECK_EQ(listing[0]["title"].asString(), std::string("Test document"));
  CHECK_EQ(listing[0]["mimeType"].asString(), std::string("text/markdown"));
  CHECK_FALSE(listing[0]["description"].asString().empty());
  CHECK_FALSE(listing[0].isMember("text"));  // the listing is an index; the body is one read away
}

TEST(mcp_resources_list_is_empty_when_no_catalog_is_injected) {
  FakeHost host;
  McpServer server(host, ServerInfo{"windmill", "0.1.0", ""});   // default: a product-neutral empty catalog
  std::optional<Json::Value> reply = server.handle(request("resources/list", Json::nullValue, 8));

  REQUIRE(reply.has_value());
  CHECK_EQ((*reply)["result"]["resources"].size(), 0u);
}

TEST(mcp_resources_read_answers_the_injected_body) {
  FakeHost host;
  McpServer server = make(host);

  Json::Value params(Json::objectValue);
  params["uri"] = "test://doc";
  std::optional<Json::Value> reply = server.handle(request("resources/read", params, 9));

  REQUIRE(reply.has_value());
  const Json::Value contents = (*reply)["result"]["contents"];
  CHECK_EQ(contents.size(), 1u);
  CHECK_EQ(contents[0]["uri"].asString(), std::string("test://doc"));
  CHECK_EQ(contents[0]["mimeType"].asString(), std::string("text/markdown"));
  CHECK_EQ(contents[0]["text"].asString(), std::string("FIXTURE BODY"));
}

TEST(mcp_resources_read_of_an_unknown_uri_names_it) {
  FakeHost host;
  McpServer server = make(host);

  Json::Value params(Json::objectValue);
  params["uri"] = "windmill://nope";
  std::optional<Json::Value> reply = server.handle(request("resources/read", params, 10));

  REQUIRE(reply.has_value());
  CHECK_EQ((*reply)["error"]["code"].asInt(), -32002);
  CHECK_EQ((*reply)["error"]["message"].asString(),
           std::string("no such resource: \"windmill://nope\" — call resources/list"));
}

TEST(mcp_resource_templates_list_is_empty_rather_than_unknown) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply =
      server.handle(request("resources/templates/list", Json::nullValue, 11));
  REQUIRE(reply.has_value());
  CHECK(( *reply)["result"]["resourceTemplates"].isArray());
  CHECK_EQ((*reply)["result"]["resourceTemplates"].size(), 0u);
}

TEST(mcp_ping_returns_empty_result) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(request("ping", Json::nullValue, 2));
  REQUIRE(reply.has_value());
  CHECK(( *reply).isMember("result"));
  CHECK_EQ((*reply)["result"].size(), 0u);
}

TEST(mcp_tools_list_passes_through_the_host_catalog) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(request("tools/list", Json::nullValue, 3));
  REQUIRE(reply.has_value());
  CHECK_EQ((*reply)["result"]["tools"].size(), 1u);
  CHECK_EQ((*reply)["result"]["tools"][0]["name"].asString(), std::string("echo"));
}

TEST(mcp_tools_call_answers_through_content_alone) {
  FakeHost host;
  McpServer server = make(host);

  Json::Value params(Json::objectValue);
  params["name"] = "echo";
  Json::Value args(Json::objectValue);
  args["x"] = 7;
  params["arguments"] = args;
  std::optional<Json::Value> reply = server.handle(request("tools/call", params, 4));

  REQUIRE(reply.has_value());
  CHECK_FALSE((*reply)["result"]["isError"].asBool());
  CHECK(( *reply)["result"]["content"].isArray());
  CHECK_EQ((*reply)["result"]["content"][0]["type"].asString(), std::string("text"));
  CHECK_EQ((*reply)["result"]["content"][0]["text"].asString(), std::string("{\"ok\":true}"));
  // structuredContent accompanies a declared outputSchema; without one it would be the whole
  // answer a second time, so a tool that declares none does not pay for it.
  CHECK_FALSE((*reply)["result"].isMember("structuredContent"));
  CHECK_EQ(host.lastName, std::string("echo"));
  CHECK_EQ(host.lastArgs["x"].asInt(), 7);
}

TEST(mcp_tools_call_passes_structured_content_through_when_a_tool_sets_it) {
  FakeHost host;
  host.declaresOutputSchema = true;  // a future tool that publishes an outputSchema opts back in
  McpServer server = make(host);

  Json::Value params(Json::objectValue);
  params["name"] = "echo";
  std::optional<Json::Value> reply = server.handle(request("tools/call", params, 4));

  REQUIRE(reply.has_value());
  CHECK(( *reply)["result"].isMember("structuredContent"));
  CHECK(( *reply)["result"]["structuredContent"]["ok"].asBool());
}

TEST(mcp_tools_call_failure_is_reported_in_result_not_transport) {
  FakeHost host;
  McpServer server = make(host);
  Json::Value params(Json::objectValue);
  params["name"] = "boom";
  std::optional<Json::Value> reply = server.handle(request("tools/call", params, 5));
  REQUIRE(reply.has_value());
  CHECK_FALSE((*reply).isMember("error"));  // a tool failure is not a JSON-RPC error
  CHECK(( *reply)["result"]["isError"].asBool());
}

TEST(mcp_tools_call_without_name_is_invalid_params) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(request("tools/call", Json::Value(Json::objectValue), 6));
  REQUIRE(reply.has_value());
  CHECK_EQ((*reply)["error"]["code"].asInt(), -32602);
}

TEST(mcp_unknown_request_method_is_method_not_found) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(request("does/notExist", Json::nullValue, 7));
  REQUIRE(reply.has_value());
  CHECK_EQ((*reply)["error"]["code"].asInt(), -32601);
}

TEST(mcp_notification_gets_no_response) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply =
      server.handle(request("notifications/initialized", Json::nullValue, Json::nullValue));
  CHECK_FALSE(reply.has_value());
}

// jsoncpp throws on asString() of a container, and on the stdio transport a throw out of handle()
// leaves main and kills the whole session — one malformed frame ending every later call. Each of
// these was a live process-terminating input.
TEST(mcp_a_container_where_a_string_belongs_is_answered_not_thrown) {
  FakeHost host;
  McpServer server = make(host);

  Json::Value read(Json::objectValue);
  read["uri"] = Json::Value(Json::arrayValue);
  std::optional<Json::Value> uri = server.handle(request("resources/read", read, 20));
  REQUIRE(uri.has_value());
  CHECK_EQ((*uri)["error"]["code"].asInt(), -32602);
  CHECK_EQ((*uri)["error"]["message"].asString(), std::string("\"uri\" must be a string"));

  Json::Value call(Json::objectValue);
  call["name"] = Json::Value(Json::arrayValue);
  std::optional<Json::Value> named = server.handle(request("tools/call", call, 21));
  REQUIRE(named.has_value());
  CHECK_EQ((*named)["error"]["code"].asInt(), -32602);
  CHECK_EQ((*named)["error"]["message"].asString(), std::string("\"name\" must be a string"));
  CHECK(host.lastName.empty());  // nothing was dispatched

  Json::Value handshake(Json::objectValue);
  handshake["protocolVersion"] = Json::Value(Json::objectValue);
  std::optional<Json::Value> version = server.handle(request("initialize", handshake, 22));
  REQUIRE(version.has_value());
  CHECK_EQ((*version)["error"]["code"].asInt(), -32602);
  CHECK_EQ((*version)["error"]["message"].asString(),
           std::string("\"protocolVersion\" must be a string"));

  Json::Value framed(Json::objectValue);
  framed["jsonrpc"] = "2.0";
  framed["id"] = 23;
  framed["method"] = Json::Value(Json::objectValue);
  std::optional<Json::Value> method = server.handle(framed);
  REQUIRE(method.has_value());
  CHECK_EQ((*method)["error"]["code"].asInt(), -32600);
  CHECK_EQ((*method)["error"]["message"].asString(), std::string("\"method\" must be a string"));
}

TEST(mcp_non_object_params_are_invalid_params_not_a_throw) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(request("tools/call", Json::Value("echo"), 12));
  REQUIRE(reply.has_value());
  CHECK_EQ((*reply)["error"]["code"].asInt(), -32602);
  CHECK_EQ((*reply)["error"]["message"].asString(), std::string("\"params\" must be an object"));
  CHECK(host.lastName.empty());  // nothing was dispatched
}

TEST(mcp_non_object_message_is_invalid_request) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(Json::Value("not an object"));
  REQUIRE(reply.has_value());
  CHECK_EQ((*reply)["error"]["code"].asInt(), -32600);
}
