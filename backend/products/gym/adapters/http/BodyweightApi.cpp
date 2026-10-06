#include "products/gym/adapters/http/BodyweightApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/GymJson.h"

#include <optional>
#include <utility>

namespace wm::gym {

BodyweightApi::BodyweightApi(std::shared_ptr<BodyweightRepository> bodyweight,
                             std::shared_ptr<AuthService> auth)
    : bodyweight_(std::move(bodyweight)), auth_(std::move(auth)) {}

// `latest` is the account's newest day whatever the window asked for, so one windowed read draws
// both the chart and the reading at the head of the log.
void BodyweightApi::listEntries(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  const BodyweightRange range{req->getParameter("from"), req->getParameter("to")};
  if ((!range.from.empty() && !wellFormedLocalDate(range.from)) ||
      (!range.to.empty() && !wellFormedLocalDate(range.to))) {
    cb(error(drogon::k400BadRequest, "could not read that date"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["entries"] = toJson(bodyweight_->entries(*caller, range));
  const std::optional<Bodyweight> latest = bodyweight_->latest(*caller);
  body["latest"] = latest ? toJson(*latest) : Json::Value(Json::nullValue);
  cb(jsonResponse(body));
}

}
