#include "products/roadmap/domain/WebAddress.h"

#include <cstdio>
#include <string_view>

namespace wm {

namespace {

std::string withoutTrailingSlash(std::string origin) {
  while (!origin.empty() && origin.back() == '/') origin.pop_back();
  return origin;
}

// encodeURIComponent's bytes: every UTF-8 byte outside its unreserved set as %XX, upper-case hex.
std::string uriComponent(std::string_view text) {
  constexpr std::string_view kUnreserved = "-_.!~*'()";
  std::string out;
  for (const char c : text) {
    const unsigned char byte = static_cast<unsigned char>(c);
    if ((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') || (byte >= '0' && byte <= '9') ||
        kUnreserved.find(c) != std::string_view::npos) {
      out += c;
      continue;
    }
    char escaped[4];
    std::snprintf(escaped, sizeof escaped, "%%%02X", byte);
    out += escaped;
  }
  return out;
}

}  // namespace

std::string treeAddress(const WebTree& web) {
  const std::string origin = withoutTrailingSlash(web.origin);
  if (web.opener == Opener::owner) return origin + "/#/app/" + web.tree.str();
  return origin + "/t/" + web.tree.str();
}

std::string stepAddress(const WebTree& web, const NodeId& step) {
  const std::string query = "step=" + uriComponent(step.str());
  if (web.opener == Opener::owner) return treeAddress(web) + "?" + query;
  return treeAddress(web) + "#?" + query;
}

}
