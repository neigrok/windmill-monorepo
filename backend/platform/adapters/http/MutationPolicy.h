#pragma once

#include <drogon/HttpRequest.h>
#include <set>
#include <string>

namespace wm {

enum class MutationRefusal { None, UntrustedOrigin, UnsupportedMediaType };
enum class MutationHeaders { Occurrences, Compatible };

struct MutationPolicy {
  MutationHeaders headers = MutationHeaders::Occurrences;
  bool cookieCredentials = false;
  bool jsonBody = true;

  MutationRefusal check(const drogon::HttpRequestPtr& request, const std::set<std::string>& origins) const;
};

}
