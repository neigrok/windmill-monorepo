#include "products/gym/adapters/http/BodyweightApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/csv/TrainingCsv.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <utility>

namespace wm::gym {

BodyweightApi::BodyweightApi(std::shared_ptr<BodyweightService> bodyweight,
                             std::shared_ptr<AuthService> auth, Clock& clock)
    : bodyweight_(std::move(bodyweight)), auth_(std::move(auth)), clock_(clock) {}

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

// Upsert by the day; the reply is the row that STANDS, which is the incoming one only when its
// `recordedAt` is at or after the stored row's — a stale replay reads back the newer correction.
// A day more than one past UTC today is refused before the body is read: the phones refuse a day
// past the device's local today at the field with the same sentence, and this is the server's
// half, loose by the one day a local calendar can run ahead of UTC.
void BodyweightApi::saveEntry(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                              const std::string& dateLocal) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  if (!wellFormedLocalDate(dateLocal)) {
    cb(error(drogon::k400BadRequest, "could not read that date"));
    return;
  }
  if (beyondTomorrowUtc(dateLocal, clock_.nowMs())) {
    cb(error(drogon::k400BadRequest, "A weigh-in is not a forecast — today or earlier."));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "could not read that weigh-in"));
    return;
  }
  std::optional<Bodyweight> incoming;
  try {
    incoming = parseBodyweightWrite(*json, dateLocal, *caller);
  } catch (const InvalidTraining& refused) {
    cb(error(drogon::k400BadRequest, refused.what()));
    return;
  }
  Json::Value body(Json::objectValue);
  body["entry"] = toJson(bodyweight_->save(*incoming));
  cb(jsonResponse(body));
}

// Absent, already gone and a day that is not a day are one answer, so a retry lands the same 204.
void BodyweightApi::deleteEntry(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                                const std::string& dateLocal) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  bodyweight_->remove(*caller, dateLocal);
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

void BodyweightApi::exportEntries(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k200OK);
  response->setContentTypeCode(drogon::CT_TEXT_CSV);
  response->addHeader("Content-Disposition",
                      "attachment; filename=\"windmill-gym-bodyweight.csv\"");
  response->setBody(toCsv(bodyweight_->exported(*caller)));
  cb(response);
}

}
