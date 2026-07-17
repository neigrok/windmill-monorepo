#include "adapters/http/ComposeApi.h"

#include <cstddef>
#include <utility>

namespace wm {

namespace {
constexpr std::size_t kMaxTextBytes = 10240;

drogon::HttpResponsePtr coded(drogon::HttpStatusCode status, const std::string& code) {
  Json::Value body(Json::objectValue);
  body["code"] = code;
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(status);
  return response;
}

bool isBlank(const std::string& text) {
  return text.find_first_not_of(" \t\r\n") == std::string::npos;
}
}

ComposeApi::ComposeApi(std::shared_ptr<PlanComposer> composer) : composer_(std::move(composer)) {}

void ComposeApi::compose(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // The pipeline the contract pins: parse → empty 400 → too-long 400 → no-key 503 →
  // compose → 200/502. (The per-IP and global rate limits sit with the other abuse
  // ceilings in infra/main.cpp, ahead of routing.)
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json || !json->isObject() || !(*json)["text"].isString() ||
      isBlank((*json)["text"].asString())) {
    callback(coded(drogon::k400BadRequest, "empty"));
    return;
  }
  const std::string text = (*json)["text"].asString();
  if (text.size() > kMaxTextBytes) {
    callback(coded(drogon::k400BadRequest, "too-long"));
    return;
  }
  if (!composer_->configured()) {
    callback(coded(drogon::k503ServiceUnavailable, "compose-unavailable"));
    return;
  }
  composer_->compose(text, [callback = std::move(callback)](std::optional<std::string> plan) {
    if (!plan) {
      callback(coded(drogon::k502BadGateway, "compose-failed"));
      return;
    }
    Json::Value body(Json::objectValue);
    body["plan"] = *plan;
    callback(drogon::HttpResponse::newHttpJsonResponse(body));
  });
}

}
