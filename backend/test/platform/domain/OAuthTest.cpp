#include "platform/domain/OAuth.h"

#include "test/testing.h"

using namespace wm;

TEST(oauth_redirect_registered_exact_https_port_agnostic_loopback) {
  std::vector<std::string> registered = {"https://app.example/cb", "http://localhost:7777/callback",
                                         "http://127.0.0.1:8888/cb"};
  CHECK(redirectRegistered(registered, "https://app.example/cb"));
  CHECK(redirectRegistered(registered, "http://localhost:7777/callback"));
  // Loopback matches ignoring the port (RFC 8252 §7.3) — the ephemeral-port case that MCP hits.
  CHECK(redirectRegistered(registered, "http://localhost:63264/callback"));
  CHECK(redirectRegistered(registered, "http://localhost/callback"));  // no port at all
  CHECK(redirectRegistered(registered, "http://127.0.0.1:1234/cb"));
  // ...but only when host and path still match.
  CHECK_FALSE(redirectRegistered(registered, "http://localhost:63264/other"));    // wrong path
  CHECK_FALSE(redirectRegistered(registered, "http://127.0.0.1:1234/callback"));  // wrong path for that host
  // https stays exact — no port/path/host slack, the open-redirect defense.
  CHECK_FALSE(redirectRegistered(registered, "https://app.example/cb/extra"));
  CHECK_FALSE(redirectRegistered(registered, "https://app.example"));
  CHECK_FALSE(redirectRegistered(registered, "https://evil.example/cb"));
}

TEST(oauth_redirect_scheme_allows_https_and_loopback_only) {
  CHECK(redirectSchemeAllowed("https://app.example/cb"));
  CHECK(redirectSchemeAllowed("http://localhost:9000/callback"));
  CHECK(redirectSchemeAllowed("http://127.0.0.1:9000/cb"));
  CHECK_FALSE(redirectSchemeAllowed("http://app.example/cb"));  // non-loopback http
  CHECK_FALSE(redirectSchemeAllowed("cursor://callback"));      // custom scheme
  CHECK_FALSE(redirectSchemeAllowed("ftp://host/cb"));
}

TEST(oauth_canonical_resource_normalizes_authority_only) {
  CHECK_EQ(canonicalResource("HTTPS://MCP.Example.COM/mcp"), std::string("https://mcp.example.com/mcp"));
  CHECK_EQ(canonicalResource("https://mcp.example.com/"), std::string("https://mcp.example.com"));
  CHECK_EQ(canonicalResource("https://mcp.example.com/mcp#frag"), std::string("https://mcp.example.com/mcp"));
  CHECK_EQ(canonicalResource("https://mcp.example.com/MCP"), std::string("https://mcp.example.com/MCP"));  // path kept
}

TEST(oauth_audience_matches_exact_or_bare_origin) {
  const std::string server = "https://mcp.example.com/mcp";
  CHECK(audienceMatches("https://mcp.example.com/mcp", server));
  CHECK(audienceMatches("https://mcp.example.com", server));       // client sent the bare origin
  CHECK(audienceMatches("HTTPS://MCP.EXAMPLE.COM/mcp", server));   // case-insensitive authority
  CHECK_FALSE(audienceMatches("https://evil.example/mcp", server));
  CHECK_FALSE(audienceMatches("https://mcp.example.com/other", server));
}
