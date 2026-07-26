#include "platform/domain/OAuth.h"

#include <algorithm>
#include <cctype>

namespace wm {

namespace {
std::string originOf(const std::string& canonical) {
  const std::size_t scheme = canonical.find("://");
  if (scheme == std::string::npos) return canonical;
  const std::size_t slash = canonical.find('/', scheme + 3);
  return slash == std::string::npos ? canonical : canonical.substr(0, slash);
}

bool isLoopbackHttp(const std::string& uri) {
  if (uri.rfind("http://", 0) != 0) return false;
  const std::string host = uri.substr(7);
  return host.rfind("localhost", 0) == 0 || host.rfind("127.0.0.1", 0) == 0 || host.rfind("[::1]", 0) == 0;
}

// A loopback redirect with its `:port` stripped, so two that differ only in port compare equal
// (RFC 8252 §7.3): "http://localhost:63264/cb" -> "http://localhost/cb".
std::string withoutLoopbackPort(const std::string& uri) {
  const std::size_t authorityStart = 7;  // past "http://"
  const std::size_t pathStart = uri.find('/', authorityStart);
  std::string authority = uri.substr(authorityStart, pathStart - authorityStart);
  const std::string path = pathStart == std::string::npos ? "" : uri.substr(pathStart);
  const std::size_t port = authority.rfind("]:") != std::string::npos ? authority.rfind("]:") + 1
                                                                       : authority.find(':');
  if (port != std::string::npos) authority.erase(port);
  return "http://" + authority + path;
}
}

bool redirectRegistered(const std::vector<std::string>& registered, const std::string& uri) {
  if (std::find(registered.begin(), registered.end(), uri) != registered.end()) return true;
  // RFC 8252 §7.3: a native client's loopback redirect may use any port at request time, so a
  // loopback URI also matches a registered loopback that differs only in port. https stays exact.
  if (!isLoopbackHttp(uri)) return false;
  const std::string canonical = withoutLoopbackPort(uri);
  for (const std::string& candidate : registered)
    if (isLoopbackHttp(candidate) && withoutLoopbackPort(candidate) == canonical) return true;
  return false;
}

bool redirectSchemeAllowed(const std::string& uri) {
  if (uri.rfind("https://", 0) == 0) return true;
  if (uri.rfind("http://", 0) != 0) return false;  // only https, or loopback http
  const std::string host = uri.substr(7);
  return host.rfind("localhost", 0) == 0 || host.rfind("127.0.0.1", 0) == 0 || host.rfind("[::1]", 0) == 0;
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
