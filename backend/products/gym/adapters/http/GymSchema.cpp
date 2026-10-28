#include "products/gym/adapters/http/GymSchema.h"

#include <charconv>

namespace wm::gym {

drogon::HttpResponsePtr gymSchemaRefusal(std::optional<std::string_view> version, std::int64_t minimum) {
  if (!version)
    return error(drogon::k426UpgradeRequired, "Update Windmill to keep using Gym.", "client-update-required");
  const std::string_view carrier = *version;
  std::int64_t schema = 0;
  const auto [end, result] = std::from_chars(carrier.data(), carrier.data() + carrier.size(), schema);
  if (carrier.empty() || result != std::errc{} || end != carrier.data() + carrier.size())
    return error(drogon::k400BadRequest, "Invalid Sync-Schema header.", "malformed");
  if (schema < minimum)
    return error(drogon::k426UpgradeRequired, "Update Windmill to keep using Gym.", "client-update-required");
  return nullptr;
}

drogon::HttpResponsePtr gymSchemaRefusal(const drogon::HttpRequestPtr& request, std::int64_t minimum) {
  if (request->method() == drogon::Options || retiredRoute(request)) return nullptr;
  const auto& headers = request->headers();
  const auto carrier = headers.find("sync-schema");
  return gymSchemaRefusal(carrier == headers.end() ? std::nullopt :
      std::optional<std::string_view>(carrier->second), minimum);
}

}
