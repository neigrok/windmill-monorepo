#include "adapters/mcp/McpServer.h"
#include "test/testing.h"

using namespace wm;

namespace {

struct FakeHost : ToolHost {
  std::string lastName;
  Json::Value lastArgs;

  Json::Value listTools() const override {
    Json::Value tools(Json::arrayValue);
    Json::Value one(Json::objectValue);
    one["name"] = "echo";
    tools.append(one);
    return tools;
  }

  ToolResult callTool(const std::string& name, const Json::Value& arguments) override {
    lastName = name;
    lastArgs = arguments;
    if (name == "boom") return ToolResult::failure("boom failed");
    Json::Value out(Json::objectValue);
    out["ok"] = true;
    return ToolResult::json(out);
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

McpServer make(FakeHost& host) {
  return McpServer(host, ServerInfo{"windmill", "0.1.0", "roadmaps as skill trees"});
}

}

TEST(mcp_initialize_reports_capabilities_and_echoes_protocol) {
  FakeHost host;
  McpServer server = make(host);

  Json::Value params(Json::objectValue);
  params["protocolVersion"] = "2025-06-18";
  std::optional<Json::Value> reply = server.handle(request("initialize", params, 1));

  CHECK(reply.has_value());
  CHECK_EQ((*reply)["id"].asInt(), 1);
  CHECK_EQ((*reply)["result"]["protocolVersion"].asString(), std::string("2025-06-18"));
  CHECK_EQ((*reply)["result"]["serverInfo"]["name"].asString(), std::string("windmill"));
  CHECK(( *reply)["result"]["capabilities"].isMember("tools"));
  CHECK_EQ((*reply)["result"]["instructions"].asString(), std::string("roadmaps as skill trees"));
}

TEST(mcp_ping_returns_empty_result) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(request("ping", Json::nullValue, 2));
  CHECK(reply.has_value());
  CHECK(( *reply).isMember("result"));
  CHECK_EQ((*reply)["result"].size(), 0u);
}

TEST(mcp_tools_list_passes_through_the_host_catalog) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(request("tools/list", Json::nullValue, 3));
  CHECK(reply.has_value());
  CHECK_EQ((*reply)["result"]["tools"].size(), 1u);
  CHECK_EQ((*reply)["result"]["tools"][0]["name"].asString(), std::string("echo"));
}

TEST(mcp_tools_call_success_carries_content_and_structured) {
  FakeHost host;
  McpServer server = make(host);

  Json::Value params(Json::objectValue);
  params["name"] = "echo";
  Json::Value args(Json::objectValue);
  args["x"] = 7;
  params["arguments"] = args;
  std::optional<Json::Value> reply = server.handle(request("tools/call", params, 4));

  CHECK(reply.has_value());
  CHECK_FALSE((*reply)["result"]["isError"].asBool());
  CHECK(( *reply)["result"]["content"].isArray());
  CHECK_EQ((*reply)["result"]["content"][0]["type"].asString(), std::string("text"));
  CHECK(( *reply)["result"].isMember("structuredContent"));
  CHECK(( *reply)["result"]["structuredContent"]["ok"].asBool());
  CHECK_EQ(host.lastName, std::string("echo"));
  CHECK_EQ(host.lastArgs["x"].asInt(), 7);
}

TEST(mcp_tools_call_failure_is_reported_in_result_not_transport) {
  FakeHost host;
  McpServer server = make(host);
  Json::Value params(Json::objectValue);
  params["name"] = "boom";
  std::optional<Json::Value> reply = server.handle(request("tools/call", params, 5));
  CHECK(reply.has_value());
  CHECK_FALSE((*reply).isMember("error"));  // a tool failure is not a JSON-RPC error
  CHECK(( *reply)["result"]["isError"].asBool());
}

TEST(mcp_tools_call_without_name_is_invalid_params) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(request("tools/call", Json::Value(Json::objectValue), 6));
  CHECK(reply.has_value());
  CHECK_EQ((*reply)["error"]["code"].asInt(), -32602);
}

TEST(mcp_unknown_request_method_is_method_not_found) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(request("does/notExist", Json::nullValue, 7));
  CHECK(reply.has_value());
  CHECK_EQ((*reply)["error"]["code"].asInt(), -32601);
}

TEST(mcp_notification_gets_no_response) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply =
      server.handle(request("notifications/initialized", Json::nullValue, Json::nullValue));
  CHECK_FALSE(reply.has_value());
}

TEST(mcp_non_object_message_is_invalid_request) {
  FakeHost host;
  McpServer server = make(host);
  std::optional<Json::Value> reply = server.handle(Json::Value("not an object"));
  CHECK(reply.has_value());
  CHECK_EQ((*reply)["error"]["code"].asInt(), -32600);
}
