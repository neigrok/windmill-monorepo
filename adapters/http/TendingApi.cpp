#include "adapters/http/TendingApi.h"

#include "adapters/http/Caller.h"
#include "domain/Tending.h"

#include <optional>
#include <utility>

namespace wm {

namespace {
drogon::HttpResponsePtr jsonResponse(const Json::Value& body, drogon::HttpStatusCode code = drogon::k200OK) {
  auto response = drogon::HttpResponse::newHttpJsonResponse(body);
  response->setStatusCode(code);
  return response;
}

drogon::HttpResponsePtr error(drogon::HttpStatusCode status, const std::string& message) {
  Json::Value body(Json::objectValue);
  body["error"] = message;
  return jsonResponse(body, status);
}

// The run's outgoing wire shape. `refusal` is empty for a run that started; `status` and
// `refusal` are the vocabulary the client branches on to pick the receipt or the quiet face.
Json::Value toJson(const TendRun& run) {
  Json::Value body(Json::objectValue);
  body["id"] = run.id;
  body["treeId"] = run.tree.str();
  body["prompt"] = run.prompt;
  body["status"] = tendStatusName(run.status);
  body["refusal"] = tendRefusalName(run.refusal);
  body["summary"] = run.summary;
  body["detail"] = run.detail;
  body["edits"] = run.edits;
  body["seqFrom"] = Json::Value::UInt64(run.seqFrom);
  body["seqTo"] = Json::Value::UInt64(run.seqTo);
  body["startedAtMs"] = Json::Value::UInt64(run.startedAtMs);
  body["finishedAtMs"] = Json::Value::UInt64(run.finishedAtMs);
  return body;
}

// The meter + receipts ledger wire shape (GET /v1/tending): the month's budget the pricing page's
// counter renders, when it resets, and the runs behind the receipts list.
Json::Value toJson(const TendingSummary& summary) {
  const TendingAllowance& allowance = summary.allowance;
  Json::Value body(Json::objectValue);
  body["enabled"] = summary.enabled;
  body["plan"] = allowance.plan == Plan::pro ? "pro" : "free";
  body["limit"] = allowance.limit;
  body["used"] = allowance.used;
  body["remaining"] = allowance.remaining();
  body["resetAtMs"] = Json::Value::UInt64(summary.resetAtMs);
  Json::Value runs(Json::arrayValue);
  for (const TendRun& run : summary.recent) runs.append(toJson(run));
  body["runs"] = runs;
  return body;
}
}

TendingApi::TendingApi(std::shared_ptr<TendingService> tending, std::shared_ptr<AuthService> auth)
    : tending_(std::move(tending)), auth_(std::move(auth)) {}

void TendingApi::tend(const drogon::HttpRequestPtr& req, HttpCallback&& callback,
                      const std::string& treeId) {
  // Resolved to the full user, not just the id: the allowance's plan lookup reads the email as its
  // second binding (a subscription bound by customer email, not only by the checkout's stamped id).
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to tend a tree"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  const std::string prompt = json ? json->get("prompt", "").asString() : "";

  // start() returns the moment the run is durable — the loop is already queued on the worker thread.
  TendRun run = tending_->start(TreeId{treeId}, caller->id, caller->email.value, prompt);
  if (run.status == TendStatus::refused) {
    // A refusal is not an error: 200 with the quiet-face body the client renders as-is.
    callback(jsonResponse(toJson(run)));
    return;
  }
  // 202: the work is accepted and underway; the id is how the client (or a phone that comes back)
  // reads the outcome from the GET below, whenever it next has a moment.
  Json::Value body(Json::objectValue);
  body["runId"] = run.id;
  callback(jsonResponse(body, drogon::k202Accepted));
}

void TendingApi::getRun(const drogon::HttpRequestPtr& req, HttpCallback&& callback,
                        const std::string& runId) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to read a tend run"));
    return;
  }
  std::optional<TendRun> run = tending_->runFor(runId, *caller);
  if (!run) {
    // Absent and not-yours are the same 404 — a run id is never an oracle for another account.
    callback(error(drogon::k404NotFound, "no such run"));
    return;
  }
  callback(jsonResponse(toJson(*run)));
}

void TendingApi::summary(const drogon::HttpRequestPtr& req, HttpCallback&& callback) {
  // The full user for the same plan lookup start() makes. Available whether or not tending is armed
  // — a signed-out caller can't have a meter, but a signed-in one always reads its month's budget.
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    callback(error(drogon::k401Unauthorized, "sign in to read your tending"));
    return;
  }
  callback(jsonResponse(toJson(tending_->summaryFor(caller->id, caller->email.value))));
}

}
