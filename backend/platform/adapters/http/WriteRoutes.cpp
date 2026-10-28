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
    "anonymous_ai_unavailable", "installation_already_present", "installation_bound", "installation_rate_limited",
    "request_conflict", "not_found", "invalid_installation", "invalid_client_address", "invalid_network", "invalid_input", "invalid_image", "input_too_large", "request_limit",
    "access_denied", "account-mismatch", "account-not-empty", "ai_allowance_disabled", "ask-attachment-invalid", "ask-busy",
    "ask-daily-limit", "ask-generation-active", "ask-image-busy", "ask-image-limit",
    "ask-not-configured", "ask-out-of-budget", "ask-request-conflict", "ask-request-malformed",
    "ask-session-open", "ask-thread-taken", "bad-id", "bad_request", "client-update-required",
    "checkout_closed", "clock-ahead", "coach-bad-request", "coach-busy", "coach-draft-invalid", "coach-draft-not-found",
    "coach-rate-limited", "coach-turn-conflict", "coach-turn-order", "coach-turn-unknown", "coach-update-required",
    "compose-unavailable",
    "concurrency_exhausted", "debt_outstanding",
    "device_bound", "device_verification_required", "expired", "free_day_exhausted", "free_month_exhausted",
    "funding_account_mismatch", "funding_binding_pending", "funding_conflict", "funding_required", "funding_unconfigured",
    "gym-engine-busy", "gym-engine-unavailable", "id-retired", "id-taken",
    "identity-taken", "invalid_client", "invalid_client_metadata", "invalid_email", "invalid_grant",
    "invalid_payment_identity", "invalid_redirect_uri", "invalid_request", "login_required", "malformed", "rate_limited",
    "replica-foreign", "request-too-large", "routine-save-in-progress", "session-deleted", "session-id-taken",
    "session-overlap", "set-id-taken", "share-id-taken", "subject_exhausted", "temporarily_unavailable",
    "unauthenticated", "unavailable", "unconfigured", "unknown-exercise", "unreachable", "unsupported_ai_pricing",
    "unsupported_grant_type", "unsupported_response_type", "upgrade-required", "voice_busy", "voice_unavailable"
};

const std::set<std::string> aiAllowanceRefusalCodes{
    "concurrency_exhausted", "debt_outstanding", "device_bound", "device_verification_required",
    "free_day_exhausted", "free_month_exhausted", "funding_required", "subject_exhausted",
    "unconfigured", "unsupported_ai_pricing"
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
  if (status != 503) return "failed";
  if ((operation == "ai.installation.issue" || operation == "ai.installation.bind" ||
       operation == "platform.GET.v1.ai.installations.current" || operation == "gym.coach.onboarding.start") &&
      code == "anonymous_ai_unavailable") return code;
  if (code == "unavailable" || code == "temporarily_unavailable" || code.rfind("gym-", 0) == 0 ||
      code.rfind("journal-", 0) == 0 || code == "ask-busy" || code == "ask-not-configured") return code;
  const bool coachTurn = operation.rfind("gym.coach.turn.", 0) == 0;
  if (coachTurn && (code == "coach-busy" || code == "anonymous_ai_unavailable")) return code;
  const bool aiRequest = coachTurn || operation == "gym.POST.v1.gym.ask" || operation == "roadmap.POST.v1.trees.id.tend" ||
      operation == "roadmap.POST.v1.compose" || operation == "journal.POST.v1.journal.transcribe";
  if (aiRequest && aiAllowanceRefusalCodes.count(code)) return code;
  if (operation == "roadmap.POST.v1.compose" && code == "compose-unavailable") return code;
  if (operation == "journal.POST.v1.journal.transcribe" &&
      (code == "voice_busy" || code == "voice_unavailable")) return code;
  if (operation == "platform.POST.v1.billing.checkout" && code == "checkout_closed") return code;
  if (operation == "platform.POST.v1.paddle.webhook" &&
      (code == "funding_binding_pending" || code == "funding_unconfigured")) return code;
  if (operation == "platform.GET.v1.ai.allowance" && code == "ai_allowance_disabled") return code;
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
