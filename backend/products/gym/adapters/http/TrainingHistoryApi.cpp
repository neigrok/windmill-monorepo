#include "products/gym/adapters/http/TrainingApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <charconv>

namespace wm::gym {
namespace {

HistoryQuery historyQuery(const drogon::HttpRequestPtr& req) {
  HistoryQuery query;
  for (const auto& [name, target] : {std::pair{"from", &query.fromMs},
      std::pair{"until", &query.untilMs}, std::pair{"before", &query.beforeMs}}) {
    const std::string value = req->getParameter(name);
    if (value.empty()) continue;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), *target);
    if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size())
      throw InvalidTraining{"invalid history range"};
  }
  query.beforeId = req->getParameter("beforeId");
  if (query.beforeId.empty() != req->getParameter("before").empty())
    throw InvalidTraining{"invalid history cursor"};
  const std::string projection = req->getParameter("projection");
  if (!projection.empty() && projection != "progress") throw InvalidTraining{"invalid projection"};
  query.includeProgress = projection == "progress";
  query.exercise = req->getParameter("exercise");
  query.routine = req->getParameter("routine");
  if (!req->getParameter("timeZone").empty()) query.timeZone = req->getParameter("timeZone");
  const std::string limit = req->getParameter("limit");
  if (!limit.empty()) {
    const auto parsed = std::from_chars(limit.data(), limit.data() + limit.size(), query.limit);
    if (parsed.ec != std::errc{} || parsed.ptr != limit.data() + limit.size())
      throw InvalidTraining{"invalid history limit"};
  }
  query.validate();
  return query;
}

Json::Value ownerShare(const LogShare& share, const std::string& baseUrl) {
  Json::Value body = toJson(share);
  body["id"] = share.id;
  body["token"] = share.token;
  body["url"] = baseUrl + "/#/gym/shared-log/" + share.token;
  return body;
}

}

void TrainingApi::history(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  const auto caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  try {
    cb(jsonResponse(toJson(training_->history(*caller, historyQuery(req)))));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that history query"));
  }
}

void TrainingApi::createLogShare(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  const auto caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to share your training log"));
    return;
  }
  const auto body = req->getJsonObject();
  if (!body || !body->isObject() || !(*body)["id"].isString() ||
      !(*body)["mode"].isString() || !(*body)["scope"].isString()) {
    cb(error(drogon::k400BadRequest, "could not read that log share"));
    return;
  }
  for (const std::string& key : body->getMemberNames()) {
    if (key == "id" || key == "mode" || key == "scope" || key == "from" || key == "until") continue;
    cb(error(drogon::k400BadRequest, "could not read that log share"));
    return;
  }
  const std::string mode = (*body)["mode"].asString();
  const std::string scope = (*body)["scope"].asString();
  if ((mode != "snapshot" && mode != "live") || (scope != "all" && scope != "range") ||
      (scope == "range" && (!(*body)["from"].isUInt64() || !(*body)["until"].isUInt64())) ||
      (scope == "all" && (body->isMember("from") || body->isMember("until")))) {
    cb(error(drogon::k400BadRequest, "could not read that log share"));
    return;
  }
  try {
    const auto share = training_->shareLog(*caller, (*body)["id"].asString(),
        mode == "snapshot" ? LogShareMode::snapshot : LogShareMode::live, scope == "range",
        scope == "range" ? (*body)["from"].asUInt64() : 0,
        scope == "range" ? (*body)["until"].asUInt64() : kMaxInstantMs);
    if (!share) {
      cb(error(drogon::k409Conflict, "that share request has already been used", "share-id-taken"));
      return;
    }
    cb(jsonResponse(ownerShare(*share, appBaseUrl_), drogon::k201Created));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that log share"));
  }
}

void TrainingApi::listLogShares(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  const auto caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your share links"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["shares"] = Json::Value(Json::arrayValue);
  for (const LogShare& share : training_->logShares(*caller))
    body["shares"].append(ownerShare(share, appBaseUrl_));
  cb(jsonResponse(body));
}

void TrainingApi::revokeLogShare(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
    const std::string& id) {
  const auto caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to revoke a share link"));
    return;
  }
  training_->revokeLogShare(*caller, id);
  const auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

void TrainingApi::sharedHistory(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
    const std::string& token) {
  try {
    const auto shared = training_->sharedHistory(token, historyQuery(req));
    if (!shared) {
      cb(error(drogon::k404NotFound, "no such shared log"));
      return;
    }
    Json::Value body = toJson(shared->page);
    body["share"] = toJson(shared->share);
    const auto response = jsonResponse(body);
    response->addHeader("Cache-Control", "no-store");
    response->addHeader("Referrer-Policy", "no-referrer");
    cb(response);
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that history query"));
  }
}

}
