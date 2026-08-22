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

// OAUTH-1, both halves of it. The authorization server is the security boundary here, and these
// are the strings that walked past it: an authority whose userinfo hid the real host, and a public
// cleartext host that a `localhost` PREFIX test called loopback.
TEST(oauth_redirect_refuses_a_uri_a_url_parser_would_read_differently) {
  std::vector<std::string> registered = {"http://127.0.0.1/callback", "http://localhost:7777/callback",
                                         "https://app.example/cb"};
  // The reported attack: every browser sends this to evil.com; the old matcher erased ":80@evil.com"
  // as a port and matched the honest client's registered loopback.
  CHECK_FALSE(redirectRegistered(registered, "http://127.0.0.1:80@evil.com/callback"));
  CHECK_FALSE(redirectRegistered(registered, "http://localhost@evil.com/callback"));
  CHECK_FALSE(redirectRegistered(registered, "https://app.example@evil.com/cb"));
  // A prefix is not a host.
  CHECK_FALSE(redirectRegistered(registered, "http://localhost.evil.com/callback"));
  CHECK_FALSE(redirectRegistered(registered, "http://127.0.0.1.attacker.example/callback"));
  // Nor is an authority we cannot read one way only.
  CHECK_FALSE(redirectRegistered(registered, "http://localhost:80:90/callback"));
  CHECK_FALSE(redirectRegistered(registered, "http://localhost:/callback"));
  CHECK_FALSE(redirectRegistered(registered, "http://localhost:abc/callback"));
  CHECK_FALSE(redirectRegistered(registered, "http:///callback"));
  // A fragment is never part of a redirect URI (RFC 6749 §3.1.2).
  CHECK_FALSE(redirectRegistered(registered, "http://localhost/callback#x"));
  // ...and the honest client still works, on whatever ephemeral port it drew this time.
  CHECK(redirectRegistered(registered, "http://127.0.0.1:54321/callback"));
  CHECK(redirectRegistered(registered, "http://localhost:1/callback"));
  CHECK(redirectRegistered(registered, "https://app.example/cb"));
  // Host case is a host's own business; the path's is not.
  CHECK(redirectRegistered(registered, "https://APP.example/cb"));
  CHECK_FALSE(redirectRegistered(registered, "https://app.example/CB"));
}

TEST(oauth_redirect_scheme_allows_only_a_parseable_https_or_exact_loopback_uri) {
  CHECK(redirectSchemeAllowed("http://[::1]:9000/cb"));
  CHECK(redirectSchemeAllowed("http://127.0.0.1/cb"));
  CHECK(redirectSchemeAllowed("https://app.example/cb?next=%2Fhome"));
  // The two registrations the audit landed, both now refused at the door.
  CHECK_FALSE(redirectSchemeAllowed("http://localhost.evil.com/cb"));
  CHECK_FALSE(redirectSchemeAllowed("http://127.0.0.1.attacker.example/steal"));
  CHECK_FALSE(redirectSchemeAllowed("http://127.0.0.1:80@evil.com/callback"));
  CHECK_FALSE(redirectSchemeAllowed("https://user:pass@app.example/cb"));
  CHECK_FALSE(redirectSchemeAllowed("http://[::1/cb"));       // an address that never closes
  CHECK_FALSE(redirectSchemeAllowed("http://localhost/cb#f"));  // fragment
  CHECK_FALSE(redirectSchemeAllowed("https://app.example/cb#f"));
  CHECK_FALSE(redirectSchemeAllowed("//app.example/cb"));
  CHECK_FALSE(redirectSchemeAllowed(""));
}

// The IPv6 loopback, whole: RFC 8252 §7.3 names [::1] beside 127.0.0.1, and a native client binds
// an ephemeral port on it exactly the same way.
TEST(oauth_redirect_ipv6_loopback_matches_with_and_without_a_port) {
  std::vector<std::string> registered = {"http://[::1]:1234/cb"};
  CHECK(redirectRegistered(registered, "http://[::1]/cb"));
  CHECK(redirectRegistered(registered, "http://[::1]:60999/cb"));
  CHECK(redirectSchemeAllowed("http://[::1]/cb"));
  CHECK_FALSE(redirectRegistered(registered, "http://[::1]:/cb"));       // a colon that names no port
  CHECK_FALSE(redirectRegistered(registered, "http://[::2]/cb"));        // not the loopback address
  CHECK_FALSE(redirectRegistered(registered, "http://[::1]@evil.com/cb"));
}

// A control character or a bare space is in no URI (RFC 3986 §2), and this is the case that was
// missing when it mattered: nothing asserted it anywhere, and `rest` — the path and query — was
// copied out of the string with no character class at all. /oauth/authorize splices a REGISTERED
// redirect into a Location header, so a registered CR/LF was HTTP response splitting on the API
// origin: an attacker registers their own client and hands a victim an authorize link that comes
// back carrying headers, and a body, of their choosing.
TEST(oauth_redirect_refuses_control_characters_anywhere_in_the_uri) {
  const std::string splice = "https://good.example/cb\r\nX-Injected: pwned\r\n\r\n<script>alert(1)</script>";
  CHECK_FALSE(redirectSchemeAllowed(splice));
  CHECK_FALSE(redirectRegistered({splice}, splice));  // not even against itself, byte for byte
  CHECK_FALSE(redirectSchemeAllowed("https://good.example/cb\r"));
  CHECK_FALSE(redirectSchemeAllowed("https://good.example/cb\n"));
  CHECK_FALSE(redirectSchemeAllowed("https://good.example/c b"));      // a bare space
  CHECK_FALSE(redirectSchemeAllowed("https://good.example/cb\tx"));    // a tab
  CHECK_FALSE(redirectSchemeAllowed(std::string("https://good.example/cb\0x", 24)));  // a NUL
  CHECK_FALSE(redirectSchemeAllowed("https://good.example/cb\x7f"));   // DEL
  CHECK_FALSE(redirectSchemeAllowed("http://local\rhost/cb"));         // inside the host
  CHECK_FALSE(redirectSchemeAllowed("https\r\n://good.example/cb"));   // inside the scheme
  // The same URI without them is the ordinary registered redirect, unharmed.
  CHECK(redirectSchemeAllowed("https://good.example/cb"));
  CHECK(redirectRegistered({"https://good.example/cb"}, "https://good.example/cb"));
}
