#pragma once

#include "platform/adapters/http/WriteRoutes.h"

#include <cstdint>
#include <optional>
#include <string_view>

namespace wm::gym {

drogon::HttpResponsePtr gymSchemaRefusal(std::optional<std::string_view> version, std::int64_t minimum);
drogon::HttpResponsePtr gymSchemaRefusal(const drogon::HttpRequestPtr& request, std::int64_t minimum);

namespace detail {

template <typename Signature> struct GymSchemaHandler;

template <typename Host, typename... Arguments>
struct GymSchemaHandler<void (Host::*)(const drogon::HttpRequestPtr&, WriteHttpCallback&&,
                                      Arguments...) const> {
  template <typename Handler>
  static auto wrap(std::int64_t minimum, Handler handler) {
    return [minimum, handler = std::move(handler)](const drogon::HttpRequestPtr& request,
                                                  WriteHttpCallback&& callback, Arguments... arguments) {
      if (auto refusal = gymSchemaRefusal(request, minimum)) {
        callback(refusal);
        return;
      }
      handler(request, std::move(callback), std::forward<Arguments>(arguments)...);
    };
  }
};

}

class GymRoutes {
public:
  GymRoutes(drogon::HttpAppFramework& app, std::int64_t minimum)
      : routes_(app, "gym"), minimum_(minimum) {}

  template <typename Handler>
  void registerHandler(const std::string& path, Handler handler,
                       const std::vector<drogon::HttpMethod>& methods) {
    routes_.registerHandler(path, detail::GymSchemaHandler<decltype(&Handler::operator())>::wrap(
        minimum_, std::move(handler)), methods);
  }

  template <typename Handler>
  void registerWriteHandler(const std::string& operation, const std::string& path, Handler handler,
                            const std::vector<drogon::HttpMethod>& methods) {
    routes_.registerWriteHandler(operation, path, detail::GymSchemaHandler<decltype(&Handler::operator())>::wrap(
        minimum_, std::move(handler)), methods);
  }

  void retire(drogon::HttpMethod method, const std::string& path) { routes_.retire(method, path); }

private:
  WriteRoutes routes_;
  std::int64_t minimum_;
};

}
