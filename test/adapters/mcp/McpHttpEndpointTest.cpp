#include "adapters/mcp/McpHttpEndpoint.h"

#include "test/testing.h"

using namespace wm;

namespace {

struct FakeHost : ToolHost {
  Json::Value listTools() const override { return Json::Value(Json::arrayValue); }
  ToolResult callTool(const std::string&, const Json::Value&) override {
    Json::Value ok(Json::objectValue);
    ok["ok"] = true;
    return ToolResult::json(ok);
  }
};

drogon::HttpRequestPtr post(const std::string& body, const std::string& session = "",
                            const std::string& origin = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Post);
  request->setPath("/mcp");
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(body);
  if (!session.empty()) request->addHeader("Mcp-Session-Id", session);
  if (!origin.empty()) request->addHeader("Origin", origin);
  return request;
}

drogon::HttpResponsePtr sendPost(McpHttpEndpoint& endpoint, const drogon::HttpRequestPtr& request) {
  drogon::HttpResponsePtr captured;
  endpoint.handlePost(request, [&](const drogon::HttpResponsePtr& response) { captured = response; });
  return captured;
}

const char* kInit =
    R"({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}})";
const char* kList = R"({"jsonrpc":"2.0","id":2,"method":"tools/list"})";

}

TEST(mcp_http_initialize_mints_a_session_and_answers) {
  FakeHost host;
  McpServer server(host, ServerInfo{"windmill", "0.1.0", ""});
  McpHttpEndpoint endpoint(server, {});

  drogon::HttpResponsePtr response = sendPost(endpoint, post(kInit));
  CHECK_EQ(response->getStatusCode(), drogon::k200OK);
  CHECK_FALSE(response->getHeader("Mcp-Session-Id").empty());
  CHECK(response->getBody().find("serverInfo") != std::string::npos);
}

TEST(mcp_http_requires_a_session_after_initialize) {
  FakeHost host;
  McpServer server(host, ServerInfo{"windmill", "0.1.0", ""});
  McpHttpEndpoint endpoint(server, {});

  drogon::HttpResponsePtr missing = sendPost(endpoint, post(kList));
  CHECK_EQ(missing->getStatusCode(), drogon::k400BadRequest);

  drogon::HttpResponsePtr unknown = sendPost(endpoint, post(kList, "deadbeef"));
  CHECK_EQ(unknown->getStatusCode(), drogon::k404NotFound);
}

TEST(mcp_http_session_from_initialize_is_accepted) {
  FakeHost host;
  McpServer server(host, ServerInfo{"windmill", "0.1.0", ""});
  McpHttpEndpoint endpoint(server, {});

  std::string session = sendPost(endpoint, post(kInit))->getHeader("Mcp-Session-Id");
  drogon::HttpResponsePtr listed = sendPost(endpoint, post(kList, session));
  CHECK_EQ(listed->getStatusCode(), drogon::k200OK);
  CHECK(listed->getBody().find("\"tools\"") != std::string::npos);
}

TEST(mcp_http_notification_gets_202) {
  FakeHost host;
  McpServer server(host, ServerInfo{"windmill", "0.1.0", ""});
  McpHttpEndpoint endpoint(server, {});

  std::string session = sendPost(endpoint, post(kInit))->getHeader("Mcp-Session-Id");
  drogon::HttpResponsePtr note =
      sendPost(endpoint, post(R"({"jsonrpc":"2.0","method":"notifications/initialized"})", session));
  CHECK_EQ(note->getStatusCode(), drogon::k202Accepted);
}

TEST(mcp_http_disallowed_origin_is_forbidden) {
  FakeHost host;
  McpServer server(host, ServerInfo{"windmill", "0.1.0", ""});
  McpHttpEndpoint endpoint(server, parseOriginList("https://app.windmill.dev"));

  drogon::HttpResponsePtr blocked = sendPost(endpoint, post(kInit, "", "https://evil.example"));
  CHECK_EQ(blocked->getStatusCode(), drogon::k403Forbidden);

  drogon::HttpResponsePtr allowed = sendPost(endpoint, post(kInit, "", "https://app.windmill.dev"));
  CHECK_EQ(allowed->getStatusCode(), drogon::k200OK);
}

TEST(mcp_http_get_is_method_not_allowed) {
  FakeHost host;
  McpServer server(host, ServerInfo{"windmill", "0.1.0", ""});
  McpHttpEndpoint endpoint(server, {});

  drogon::HttpResponsePtr response;
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Get);
  endpoint.handleGet(request, [&](const drogon::HttpResponsePtr& r) { response = r; });
  CHECK_EQ(response->getStatusCode(), drogon::k405MethodNotAllowed);
}

TEST(mcp_http_delete_ends_the_session) {
  FakeHost host;
  McpServer server(host, ServerInfo{"windmill", "0.1.0", ""});
  McpHttpEndpoint endpoint(server, {});

  std::string session = sendPost(endpoint, post(kInit))->getHeader("Mcp-Session-Id");

  drogon::HttpResponsePtr deleted;
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Delete);
  request->addHeader("Mcp-Session-Id", session);
  endpoint.handleDelete(request, [&](const drogon::HttpResponsePtr& r) { deleted = r; });
  CHECK_EQ(deleted->getStatusCode(), drogon::k200OK);

  // The session is gone, so a follow-up call is rejected.
  CHECK_EQ(sendPost(endpoint, post(kList, session))->getStatusCode(), drogon::k404NotFound);
}
