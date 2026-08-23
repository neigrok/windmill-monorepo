#include "platform/domain/OAuth.h"

#include <algorithm>
#include <cctype>
#include <optional>

namespace wm {

namespace {
std::string originOf(const std::string& canonical) {
  const std::size_t scheme = canonical.find("://");
  if (scheme == std::string::npos) return canonical;
  const std::size_t slash = canonical.find('/', scheme + 3);
  return slash == std::string::npos ? canonical : canonical.substr(0, slash);
}

// A redirect URI split the way a URL parser splits it. Nothing downstream may guess where the host
// ends: a uri a parser would read differently is refused, never canonicalized.
struct RedirectUri {
  std::string scheme;  // lowercased: "http" or "https"
  std::string host;    // lowercased, no port; an IPv6 literal keeps its brackets
  std::string port;    // digits, or empty
  std::string rest;    // path + query, byte for byte — case and encoding are significant here
  bool loopback = false;
};

bool isHostChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.';
}

std::string lowered(const std::string& value) {
  std::string out = value;
  for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

std::optional<RedirectUri> parseRedirect(const std::string& uri) {
  // Check the whole string before splitting: a registered redirect is spliced into a `Location:`
  // header, so a CR or LF anywhere in it is HTTP response splitting. No control character or bare
  // space belongs in any URI (RFC 3986 §2).
  for (char c : uri)
    if (static_cast<unsigned char>(c) <= 0x20 || static_cast<unsigned char>(c) == 0x7f) return std::nullopt;

  const std::size_t mark = uri.find("://");
  if (mark == std::string::npos) return std::nullopt;
  RedirectUri parsed;
  parsed.scheme = lowered(uri.substr(0, mark));
  if (parsed.scheme != "http" && parsed.scheme != "https") return std::nullopt;

  const std::size_t authorityStart = mark + 3;
  const std::size_t authorityEnd = uri.find_first_of("/?#", authorityStart);
  const std::string authority =
      uri.substr(authorityStart, authorityEnd == std::string::npos ? std::string::npos : authorityEnd - authorityStart);
  parsed.rest = authorityEnd == std::string::npos ? "" : uri.substr(authorityEnd);
  if (authority.empty()) return std::nullopt;
  // Userinfo: everything before an '@' is a credential, not a host.
  if (authority.find('@') != std::string::npos) return std::nullopt;
  // A fragment can never be part of a redirect URI (RFC 6749 §3.1.2).
  if (parsed.rest.find('#') != std::string::npos) return std::nullopt;

  std::string hostPart = authority;
  std::string portPart;
  if (authority.front() == '[') {
    const std::size_t close = authority.find(']');
    if (close == std::string::npos) return std::nullopt;
    hostPart = authority.substr(0, close + 1);
    const std::string tail = authority.substr(close + 1);
    if (!tail.empty() && tail.front() != ':') return std::nullopt;
    portPart = tail.empty() ? "" : tail.substr(1);
    for (std::size_t i = 1; i + 1 < hostPart.size(); ++i) {
      const char c = hostPart[i];
      if (!std::isxdigit(static_cast<unsigned char>(c)) && c != ':' && c != '.') return std::nullopt;
    }
    if (hostPart.size() <= 2) return std::nullopt;
    // "[::1]:" — a colon that opens a port and then names none.
    if (!tail.empty() && portPart.empty()) return std::nullopt;
  } else {
    const std::size_t colon = authority.find(':');
    if (colon != std::string::npos) {
      hostPart = authority.substr(0, colon);
      portPart = authority.substr(colon + 1);
      // A second colon means the authority is not what it looks like.
      if (portPart.find(':') != std::string::npos) return std::nullopt;
    }
    if (hostPart.empty()) return std::nullopt;
    if (colon != std::string::npos && portPart.empty()) return std::nullopt;  // "host:" names no port
    for (char c : hostPart)
      if (!isHostChar(c)) return std::nullopt;
  }
  if (portPart.size() > 5) return std::nullopt;
  for (char c : portPart)
    if (c < '0' || c > '9') return std::nullopt;

  parsed.host = lowered(hostPart);
  parsed.port = portPart;
  // Exactly these three hosts, never a prefix: "localhost.evil.com" is a public cleartext host.
  parsed.loopback = parsed.scheme == "http" &&
                    (parsed.host == "localhost" || parsed.host == "127.0.0.1" || parsed.host == "[::1]");
  return parsed;
}

// https or loopback http, the only two a redirect may be (OAuth 2.1 §1.5), asked of a parsed uri.
bool allowedTarget(const RedirectUri& uri) { return uri.scheme == "https" || uri.loopback; }

// Scheme, host and path/query match exactly; the port may differ only when both sides are
// loopback (RFC 8252 §7.3).
bool sameTarget(const RedirectUri& request, const RedirectUri& registered) {
  if (request.scheme != registered.scheme) return false;
  if (request.host != registered.host) return false;
  if (request.rest != registered.rest) return false;
  if (request.loopback && registered.loopback) return true;
  return request.port == registered.port;
}
}

bool redirectRegistered(const std::vector<std::string>& registered, const std::string& uri) {
  // Both sides go through the same parse: a registered uri is no more trusted than a presented one.
  const std::optional<RedirectUri> request = parseRedirect(uri);
  if (!request || !allowedTarget(*request)) return false;
  for (const std::string& candidate : registered) {
    const std::optional<RedirectUri> known = parseRedirect(candidate);
    if (!known || !allowedTarget(*known)) continue;
    if (sameTarget(*request, *known)) return true;
  }
  return false;
}

bool redirectSchemeAllowed(const std::string& uri) {
  const std::optional<RedirectUri> parsed = parseRedirect(uri);
  return parsed && allowedTarget(*parsed);
}

std::string canonicalResource(const std::string& uri) {
  std::string value = uri;
  const std::size_t hash = value.find('#');
  if (hash != std::string::npos) value.erase(hash);  // fragments are never part of the resource

  const std::size_t scheme = value.find("://");
  const std::size_t authorityEnd =
      scheme == std::string::npos ? 0 : std::min(value.size(), value.find('/', scheme + 3));
  for (std::size_t i = 0; i < authorityEnd; ++i)
    value[i] = static_cast<char>(std::tolower(static_cast<unsigned char>(value[i])));

  while (!value.empty() && value.back() == '/') value.pop_back();
  return value;
}

bool audienceMatches(const std::string& tokenResource, const std::string& serverResource) {
  const std::string token = canonicalResource(tokenResource);
  const std::string server = canonicalResource(serverResource);
  return token == server || token == originOf(server) || originOf(token) == server;
}

}
