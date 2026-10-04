#pragma once

#include "platform/application/WriteObservation.h"

#include <drogon/drogon.h>

#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace wm {

using WriteHttpCallback = std::function<void(const drogon::HttpResponsePtr&)>;
inline constexpr char kWriteObservationAttribute[] = "wm.write_observation";

struct WriteRoute {
  std::string path;
  std::string operation;
  std::string product;
  std::string door;
  std::vector<drogon::HttpMethod> methods;
};

bool mutatingMethod(drogon::HttpMethod method);
std::string routeOperation(const std::string& product, const std::string& path,
                           const std::vector<drogon::HttpMethod>& methods);
void declareWriteRoute(WriteRoute route);
std::vector<WriteRoute> registeredWriteRoutes();
std::shared_ptr<WriteObservation> beginWriteRequest(const drogon::HttpRequestPtr& request);
std::shared_ptr<WriteObservation> beginWriteRequest(const drogon::HttpRequestPtr& request,
                                                  const WriteRoute& route);
void finishWriteRequest(const drogon::HttpRequestPtr& request, const drogon::HttpResponsePtr& response);
void writeHttpFailure(const drogon::HttpRequestPtr& request, const std::exception& error);
void writeHttpFailureUnknown(const drogon::HttpRequestPtr& request);
std::string writeHttpOutcome(const drogon::HttpResponsePtr& response, const std::string& operation);
void installPrivacySafeExceptionHandler(drogon::HttpAppFramework& app,
    std::function<void(const std::exception&, const drogon::HttpRequestPtr&)> onFailure = {},
    bool jsonError = false);

template <typename Run>
decltype(auto) observeHttpWork(const drogon::HttpRequestPtr& request, Run&& run) {
  const auto observation = beginWriteRequest(request);
  if (!observation) return std::forward<Run>(run)();
  WriteContext context(*observation);
  try {
    return std::forward<Run>(run)();
  } catch (const std::exception& error) {
    observation->fail(error);
    throw;
  } catch (...) {
    observation->failUnknown();
    throw;
  }
}

template <typename Callback>
auto observedHttpCallback(const drogon::HttpRequestPtr& request, Callback callback) {
  return [request, callback = std::move(callback)](auto&&... arguments) mutable -> decltype(auto) {
    return observeHttpWork(request, [&]() -> decltype(auto) {
      return callback(std::forward<decltype(arguments)>(arguments)...);
    });
  };
}

namespace detail {

template <typename Signature> struct ObservedHttpHandler;

template <typename Host, typename... Arguments>
struct ObservedHttpHandler<void (Host::*)(const drogon::HttpRequestPtr&, WriteHttpCallback&&,
                                         Arguments...) const> {
  template <typename Handler>
  static auto wrap(const WriteRoute& route, Handler handler) {
    return [route, handler = std::move(handler)](const drogon::HttpRequestPtr& request,
                                               WriteHttpCallback&& callback, Arguments... arguments) {
      beginWriteRequest(request, route);
      WriteHttpCallback observed = observedHttpCallback(request,
          [request, callback = std::move(callback)](const drogon::HttpResponsePtr& response) {
            callback(response);
            finishWriteRequest(request, response);
          });
      observeHttpWork(request, [&] {
        handler(request, std::move(observed), std::forward<Arguments>(arguments)...);
      });
    };
  }
};

}

class WriteRoutes {
public:
  explicit WriteRoutes(drogon::HttpAppFramework& app, std::string product,
                       std::string door = "rest")
      : app_(app), product_(std::move(product)), door_(std::move(door)) {}

  template <typename Handler>
  void registerHandler(const std::string& path, Handler handler,
                       const std::vector<drogon::HttpMethod>& methods) {
    for (const auto method : methods) {
      if (!mutatingMethod(method)) continue;
      registerWriteHandler(routeOperation(product_, path, methods), path, std::move(handler), methods);
      return;
    }
    std::vector<drogon::internal::HttpConstraint> constraints;
    for (const auto method : methods) constraints.emplace_back(method);
    app_.registerHandler(path, std::move(handler), constraints);
  }

  template <typename Handler>
  void registerWriteHandler(const std::string& operation, const std::string& path, Handler handler,
                            const std::vector<drogon::HttpMethod>& methods) {
    WriteRoute route{path, operation, product_, door_, methods};
    declareWriteRoute(route);
    std::vector<drogon::internal::HttpConstraint> constraints;
    for (const auto method : methods) constraints.emplace_back(method);
    app_.registerHandler(path, detail::ObservedHttpHandler<decltype(&Handler::operator())>::wrap(
                                   route, std::move(handler)), constraints);
  }

private:
  drogon::HttpAppFramework& app_;
  std::string product_;
  std::string door_;
};

}
