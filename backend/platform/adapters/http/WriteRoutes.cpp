#include "platform/adapters/http/WriteRoutes.h"

#include <algorithm>
#include <cctype>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string_view>
#include <typeinfo>

namespace wm {
namespace {
std::mutex routesMutex;
std::vector<WriteRoute> routes;

bool routeMatches(std::string_view pattern, std::string_view path) {
  while (!pattern.empty()) {
    if (pattern.front() != '{') {
      if (path.empty() || std::tolower(static_cast<unsigned char>(pattern.front())) !=
                              std::tolower(static_cast<unsigned char>(path.front()))) return false;
      pattern.remove_prefix(1);
      path.remove_prefix(1);
      continue;
    }
    const auto end = pattern.find('}');
    if (end == std::string_view::npos || path.empty()) return false;
    pattern.remove_prefix(end + 1);
    const auto slash = path.find('/');
    path.remove_prefix(slash == std::string_view::npos ? path.size() : slash);
  }
  return path.empty();
}

struct HttpWriteFailure : std::runtime_error {
  HttpWriteFailure() : std::runtime_error("HTTP write failed") {}
};

const std::set<std::string> refusalCodes{
    "access_denied", "account-mismatch", "account-not-empty", "ask-attachment-invalid", "ask-busy",
    "ask-daily-limit", "ask-generation-active", "ask-image-busy", "ask-image-limit",
    "ask-not-configured", "ask-out-of-budget", "ask-request-conflict", "ask-request-malformed",
    "ask-session-open", "ask-thread-taken", "authorization_pending", "bad-id", "bad_request",
    "client-update-required", "clock-ahead", "cursor-invalid", "epoch-mismatch", "expired",
    "gym-engine-busy", "gym-engine-unavailable", "gym-not-adopted", "id-retired", "id-taken",
    "identity-taken", "invalid_client", "invalid_client_metadata",
    "invalid_email", "invalid_grant", "invalid_redirect_uri", "invalid_request", "invalid_scope",
    "login_required", "malformed", "rate_limited", "replica-foreign",
    "replica-unknown", "request-too-large", "scope-forbidden", "scope-unknown", "server_error",
    "session-deleted", "session-id-taken", "session-overlap", "set-id-taken", "share-id-taken",
    "slow_down", "temporarily_unavailable", "unauthenticated", "unauthorized_client", "unavailable",
    "unknown-exercise", "unreachable", "unsupported_grant_type", "unsupported_response_type",
    "upgrade-required"
};

std::string redirectCode(const std::string& location) {
  const auto marker = location.rfind("?error=");
  if (marker == std::string::npos) return {};
  const auto begin = marker + 7;
  const auto end = location.find('&', begin);
  const std::string code = location.substr(begin, end == std::string::npos ? end : end - begin);
  return refusalCodes.count(code) ? code : std::string{};
}

std::string responseCode(const drogon::HttpResponsePtr& response) {
  std::shared_ptr<Json::Value> body;
  try { body = response->getJsonObject(); }
  catch (const std::exception&) { return {}; }
  if (!body || !body->isObject()) return {};
  const Json::Value& fields = *body;
  for (const char* field : {"code", "error"}) {
    const auto& value = fields[field];
    if (!value.isString()) continue;
    const std::string code = value.asString();
    if (refusalCodes.count(code)) return code;
  }
  return {};
}
}

bool mutatingMethod(drogon::HttpMethod method) {
  return method == drogon::Post || method == drogon::Put || method == drogon::Patch || method == drogon::Delete;
}

std::string routeOperation(const std::string& product, const std::string& path,
                           const std::vector<drogon::HttpMethod>& methods) {
  std::string operation = product + ".";
  if (!methods.empty()) operation += drogon::to_string_view(methods.front());
  for (const unsigned char byte : path) {
    if (std::isalnum(byte) || byte == '_') operation += static_cast<char>(std::tolower(byte));
    else if (operation.back() != '.') operation += '.';
  }
  if (operation.back() == '.') operation.pop_back();
  return operation;
}

void declareWriteRoute(WriteRoute route) {
  std::lock_guard<std::mutex> lock(routesMutex);
  routes.push_back(std::move(route));
}

std::vector<WriteRoute> registeredWriteRoutes() {
  std::lock_guard<std::mutex> lock(routesMutex);
  return routes;
}

bool retiredRoute(const drogon::HttpRequestPtr& request) {
  return request->attributes()->get<bool>("wm.retired_route");
}

drogon::HttpResponsePtr retiredWriteResponse() {
  return error(drogon::k410Gone, "This version of the app can no longer save; update it.", "client-update-required");
}

std::shared_ptr<WriteObservation> beginWriteRequest(const drogon::HttpRequestPtr& request,
                                                  const WriteRoute& route) {
  if (request->attributes()->find(kWriteObservationAttribute))
    return request->attributes()->get<std::shared_ptr<WriteObservation>>(kWriteObservationAttribute);
  auto observation = std::make_shared<WriteObservation>(route.operation, route.product, route.door);
  request->attributes()->insert(kWriteObservationAttribute, observation);
  request->attributes()->insert("wm.write_operation", route.operation);
  request->attributes()->insert("wm.retired_route", route.retired);
  return observation;
}

std::shared_ptr<WriteObservation> beginWriteRequest(const drogon::HttpRequestPtr& request) {
  if (request->attributes()->find(kWriteObservationAttribute))
    return request->attributes()->get<std::shared_ptr<WriteObservation>>(kWriteObservationAttribute);
  for (const WriteRoute& route : registeredWriteRoutes()) {
    if (std::find(route.methods.begin(), route.methods.end(), request->method()) == route.methods.end()) continue;
    if (routeMatches(route.path, request->path())) return beginWriteRequest(request, route);
  }
  return nullptr;
}

std::string writeHttpOutcome(const drogon::HttpResponsePtr& response, const std::string& operation) {
  if (!response) return "failed";
  const int status = response->statusCode();
  if (status < 400) {
    if (operation == "oauth.authorize") {
      const std::string code = redirectCode(response->getHeader("location"));
      if (!code.empty()) return code;
    }
    if (operation == "platform.POST.v1.oauth.decision") {
      const auto body = response->getJsonObject();
      const Json::Value& fields = body ? *body : Json::Value::nullSingleton();
      if (fields.isObject() && fields["redirect"].isString()) {
        const std::string code = redirectCode(fields["redirect"].asString());
        if (!code.empty()) return code;
      }
    }
    if (operation == "auth.google.callback") {
      if (response->getHeader("location").find("signin=google_failed") != std::string::npos) return "google_failed";
      if (response->cookies().empty()) return "unavailable";
    }
    if (operation == "auth.google.start" && response->cookies().empty()) return "unavailable";
    return "ok";
  }
  const std::string code = responseCode(response);
  if (status < 500) return code.empty() ? "http_" + std::to_string(status) : code;
  if (status == 503 && (code == "unavailable" || code == "temporarily_unavailable" || code.rfind("gym-", 0) == 0 ||
                        code.rfind("journal-", 0) == 0 || code == "ask-busy" ||
                        code == "ask-not-configured")) return code;
  if (status == 503 && (operation == "platform.POST.v1.billing.checkout" ||
                       operation == "journal.POST.v1.journal.transcribe")) return "unavailable";
  return "failed";
}

void finishWriteRequest(const drogon::HttpRequestPtr& request, const drogon::HttpResponsePtr& response) {
  const auto observation = beginWriteRequest(request);
  if (!observation) return;
  const std::string operation = request->attributes()->get<std::string>("wm.write_operation");
  const std::string outcome = writeHttpOutcome(response, operation);
  if (outcome == "failed") {
    observation->fail(HttpWriteFailure{});
    return;
  }
  observation->finish(outcome);
}

void writeHttpFailure(const drogon::HttpRequestPtr& request, const std::exception& error) {
  const auto observation = beginWriteRequest(request);
  if (observation) observation->fail(error);
}

void writeHttpFailureUnknown(const drogon::HttpRequestPtr& request) {
  const auto observation = beginWriteRequest(request);
  if (observation) observation->failUnknown();
}

void installPrivacySafeExceptionHandler(drogon::HttpAppFramework& app,
    std::function<void(const std::exception&, const drogon::HttpRequestPtr&)> onFailure, bool jsonError) {
  app.setExceptionHandler([&app, jsonError, onFailure = std::move(onFailure)](const std::exception& error,
      const drogon::HttpRequestPtr& request, WriteHttpCallback&& callback) {
    const std::string route = request->matchedPathPattern().empty() ? "unmatched" :
        std::string(request->matchedPathPattern());
    LOG_ERROR << "unexpected request exception; route=" << route << " type=" << typeid(error).name();
    const auto observation = beginWriteRequest(request);
    if (observation) observation->fail(error);
    if (!observation && !onFailure) {
      WriteObservation fallback("http.exception", "platform", "rest");
      fallback.fail(error);
    }
    if (onFailure) {
      try { onFailure(error, request); }
      catch (...) { LOG_ERROR << "request failure mirror dropped"; }
    }
    if (!jsonError) {
      callback(app.getCustomErrorHandler()(drogon::k500InternalServerError, request));
      return;
    }
    Json::Value body(Json::objectValue);
    body["error"] = "internal error";
    auto response = drogon::HttpResponse::newHttpJsonResponse(body);
    response->setStatusCode(drogon::k500InternalServerError);
    callback(response);
  });
}

}
