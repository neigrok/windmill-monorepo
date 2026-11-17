#include "platform/adapters/http/MutationPolicy.h"

#include <optional>

namespace wm {

MutationRefusal MutationPolicy::check(const drogon::HttpRequestPtr& request, const std::set<std::string>& origins) const {
  std::optional<std::string> origin;
  std::optional<std::string> mediaType;
  if (headers == MutationHeaders::Compatible) {
    const auto& value = request->getHeader("origin");
    if (!value.empty()) origin = value;
    mediaType = request->getHeader("content-type");
  } else {
    for (auto [name, value] : request->headerOccurrences()) {
      for (char& c : name) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
      const auto first = value.find_first_not_of(" \t");
      value = first == std::string::npos ? "" : value.substr(first, value.find_last_not_of(" \t") - first + 1);
      if (name == "origin") {
        if (origin) return MutationRefusal::UntrustedOrigin;
        origin = std::move(value);
      } else if (name == "content-type" && jsonBody) {
        if (mediaType) return MutationRefusal::UnsupportedMediaType;
        mediaType = std::move(value);
      }
    }
  }
  const bool trusted = headers == MutationHeaders::Compatible
      ? origins.contains(origin.value_or("")) : origin && origins.contains(*origin);
  if ((cookieCredentials || origin) && !trusted)
    return MutationRefusal::UntrustedOrigin;
  if (!jsonBody) return MutationRefusal::None;
  std::string essence = mediaType.value_or("");
  essence = essence.substr(0, essence.find(';'));
  const auto first = essence.find_first_not_of(" \t");
  essence = first == std::string::npos ? "" : essence.substr(first, essence.find_last_not_of(" \t") - first + 1);
  for (char& c : essence) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
  if (essence != "application/json") return MutationRefusal::UnsupportedMediaType;
  return MutationRefusal::None;
}

}
