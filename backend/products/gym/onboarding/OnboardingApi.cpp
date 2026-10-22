#include "products/gym/onboarding/OnboardingApi.h"

#include "products/gym/adapters/http/CoachImage.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/http/WriteRoutes.h"
#include "platform/adapters/json/AiBudgetJson.h"

#include <drogon/utils/Utilities.h>

namespace wm::gym {
namespace {

drogon::HttpResponsePtr privateResponse(const drogon::HttpResponsePtr& response) {
  response->addHeader("Cache-Control", "private, no-store");
  return response;
}

drogon::HttpResponsePtr refusal(drogon::HttpStatusCode status, const std::string& code) {
  return privateResponse(error(status, "Coach could not take this message.", code.c_str()));
}

drogon::HttpResponsePtr response(const OnboardingRecord& record, const AiBudgetView& allowance, bool post) {
  Json::Value out(Json::objectValue);
  out["requestId"] = record.requestId;
  out["resultId"] = record.resultId;
  out["status"] = record.state;
  out["expiresAtMs"] = Json::Int64(record.expiresAtMs);
  out["message"] = record.payload.isObject() ? record.payload.get("message", "") : Json::Value("");
  out["routines"] = record.payload.isObject() ? record.payload["routines"] : Json::Value(Json::arrayValue);
  out["errorCode"] = record.errorCode.empty() ? Json::Value() : Json::Value(record.errorCode);
  out["allowance"] = aiAllowanceJson(allowance);
  return privateResponse(jsonResponse(out, post && record.state == "pending" ? drogon::k202Accepted : drogon::k200OK));
}

}

OnboardingApi::OnboardingApi(std::shared_ptr<OnboardingService> service,
    std::shared_ptr<AiInstallationApi> installations, std::shared_ptr<FailureReporter> failures)
    : service_(std::move(service)), installations_(std::move(installations)), failures_(std::move(failures)) {}

void OnboardingApi::stop() { workers_.stopAndJoin(); }

void OnboardingApi::start(const drogon::HttpRequestPtr& request,
                         std::function<void(const drogon::HttpResponsePtr&)>&& reply) {
  if (request->body().size() > 4 * ((kOnboardingImageBytes + 2) / 3) + 131072) {
    reply(refusal(drogon::k413RequestEntityTooLarge, "input_too_large")); return;
  }
  auto callback = std::make_shared<std::function<void(const drogon::HttpResponsePtr&)>>(std::move(reply));
  if (!workers_.post([this, request, callback] {
    observeHttpWork(request, [&] {
      try {
        const auto access = installations_->resolve(request);
        if (!access.refusal.empty()) { (*callback)(refusal(drogon::k401Unauthorized, access.refusal)); return; }
        if (access.account || access.installation->boundAccount()) { (*callback)(refusal(drogon::k409Conflict, "device_bound")); return; }
        const auto address = installations_->clientAddress(request);
        if (!address) { (*callback)(refusal(drogon::k400BadRequest, "invalid_network")); return; }
        const auto body = request->getJsonObject();
        auto input = body ? readOnboardingIn(*body) : std::nullopt;
        if (!input) { (*callback)(refusal(drogon::k400BadRequest, "invalid_input")); return; }
        if (!input->imageBase64.empty()) {
          const auto bytes = drogon::utils::base64Decode(input->imageBase64);
          if (bytes.size() > kOnboardingImageBytes || drogon::utils::base64Encode(bytes) != input->imageBase64 ||
              !decodeCoachImage("onboarding", input->imageMimeType, bytes)) {
            (*callback)(refusal(drogon::k400BadRequest, "invalid_image")); return;
          }
        }
        auto result = service_->start(*access.installation, *address, std::move(*input));
        if (!result.record) {
          const auto status = result.refusal == "anonymous_ai_unavailable" ? drogon::k503ServiceUnavailable :
                              result.refusal == "request_limit" ? drogon::k429TooManyRequests : drogon::k409Conflict;
          (*callback)(refusal(status, result.refusal));
          return;
        }
        (*callback)(response(*result.record, service_->allowance(*access.installation, &*result.record), true));
      } catch (const std::exception& error) {
        writeHttpFailure(request, error);
        (*callback)(refusal(drogon::k500InternalServerError, "internal_error"));
      } catch (...) {
        writeHttpFailureUnknown(request);
        (*callback)(refusal(drogon::k500InternalServerError, "internal_error"));
      }
    });
  })) (*callback)(refusal(drogon::k503ServiceUnavailable, "unavailable"));
}

void OnboardingApi::get(const drogon::HttpRequestPtr& request,
    std::function<void(const drogon::HttpResponsePtr&)>&& reply, const std::string& requestId) {
  auto callback = std::make_shared<std::function<void(const drogon::HttpResponsePtr&)>>(std::move(reply));
  if (!workers_.post([this, request, callback, requestId] {
    try {
      const auto access = installations_->resolve(request);
      if (!access.refusal.empty()) { (*callback)(refusal(drogon::k401Unauthorized, access.refusal)); return; }
      if (!validOnboardingRequestId(requestId)) { (*callback)(refusal(drogon::k404NotFound, "not_found")); return; }
      const auto record = service_->get(*access.installation, requestId);
      if (!record) { (*callback)(refusal(drogon::k404NotFound, "not_found")); return; }
      (*callback)(response(*record, service_->allowance(*access.installation, &*record), false));
    } catch (...) {
      if (failures_) failures_->report("gym", "gym.coach.onboarding.read", "result unavailable");
      (*callback)(refusal(drogon::k500InternalServerError, "internal_error"));
    }
  })) (*callback)(refusal(drogon::k503ServiceUnavailable, "unavailable"));
}

}
