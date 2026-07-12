#include "domain/OAuth.h"

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
}

bool redirectRegistered(const std::vector<std::string>& registered, const std::string& uri) {
  return std::find(registered.begin(), registered.end(), uri) != registered.end();
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
