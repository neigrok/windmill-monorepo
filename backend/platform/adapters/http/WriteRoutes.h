#pragma once

#include "platform/application/WriteObservation.h"
#include "platform/adapters/http/JsonReply.h"

#include <drogon/drogon.h>

#include <algorithm>
#include <functional>
#include <memory>
#include <stdexcept>
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
  bool retired = false;
};

bool mutatingMethod(drogon::HttpMethod method);
std::string routeOperation(const std::string& product, const std::string& path,
                           const std::vector<drogon::HttpMethod>& methods);
void declareWriteRoute(WriteRoute route);
std::vector<WriteRoute> registeredWriteRoutes();
// Whether the request matched a retired write path: its tombstone answers it, and no rate limit counts it.
bool retiredRoute(const drogon::HttpRequestPtr& request);
// What a retired write path answers: 410 `client-update-required`, with the sentence an old client shows.
drogon::HttpResponsePtr retiredWriteResponse();
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
    registerRoute({path, operation, product_, door_, methods}, std::move(handler));
  }

  // A write path an installed client still calls after its writes moved elsewhere: it answers
  // retiredWriteResponse() before auth with nothing behind it, and is observed like any write.
  void retire(drogon::HttpMethod method, const std::string& path) {
    const WriteRoute route{path, routeOperation(product_, path, {method}), product_, door_, {method}, true};
    switch (std::count(path.begin(), path.end(), '{')) {
      case 0:
        registerRoute(route, [](const drogon::HttpRequestPtr&, WriteHttpCallback&& cb) { cb(retiredWriteResponse()); });
        return;
      case 1:
        registerRoute(route, [](const drogon::HttpRequestPtr&, WriteHttpCallback&& cb, const std::string&) {
          cb(retiredWriteResponse());
        });
        return;
      case 2:
        registerRoute(route, [](const drogon::HttpRequestPtr&, WriteHttpCallback&& cb, const std::string&,
                                const std::string&) { cb(retiredWriteResponse()); });
        return;
      default:
        throw std::logic_error("a retired path names at most two parameters: " + path);
    }
  }

private:
  template <typename Handler>
  void registerRoute(WriteRoute route, Handler handler) {
    declareWriteRoute(route);
    std::vector<drogon::internal::HttpConstraint> constraints;
    for (const auto method : route.methods) constraints.emplace_back(method);
    app_.registerHandler(route.path, detail::ObservedHttpHandler<decltype(&Handler::operator())>::wrap(
                                   route, std::move(handler)), constraints);
  }

  drogon::HttpAppFramework& app_;
  std::string product_;
  std::string door_;
};

}
