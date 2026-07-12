#include "domain/OAuth.h"

#include "test/testing.h"

using namespace wm;

TEST(oauth_redirect_registered_is_exact_match_only) {
  std::vector<std::string> registered = {"https://app.example/cb", "http://localhost:7777/callback"};
  CHECK(redirectRegistered(registered, "https://app.example/cb"));
  CHECK(redirectRegistered(registered, "http://localhost:7777/callback"));
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
