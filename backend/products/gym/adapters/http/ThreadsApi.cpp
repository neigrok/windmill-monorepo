#include "products/gym/adapters/http/ThreadsApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/csv/TrainingCsv.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <string>
#include <utility>

namespace wm::gym {

ThreadsApi::ThreadsApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth)
    : log_(std::move(log)), auth_(std::move(auth)) {}


// ── Ask's threads (§O) ─────────────────────────────────────────────────────────────────────────
//
// THE LIST IS NOT AN INBOX, and nothing here makes one: no unread count, no badge, no state a
// client could draw as something waiting. Every row is a title the lifter typed and an outcome the
// server observed, and the reply carries nothing else — because there is nothing else that would be
// true.
void ThreadsApi::listThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(toJson(log_->threads(*caller))));
}

void ThreadsApi::getThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                       const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<AskThread> held = log_->thread(*caller, ThreadId{id});
  if (!held) {
    // Absent and another account's, told apart by nobody — the one answer every owner-scoped read in
    // this product gives.
    cb(error(drogon::k404NotFound, "no such conversation"));
    return;
  }
  cb(jsonResponse(toJson(*held)));
}

// DELETE DELETES THE CONVERSATION, NOT THE CONSEQUENCE (§O). The turns go with the row; the
// proposals it minted do not — an applied change stays in the routine's history, still saying it came
// from Ask, and simply no longer opens a conversation that exists. That is not a leniency about
// deletion: an applied change is a fact about somebody's program rather than a message, and deleting
// the message must not rewrite what their program did.
void ThreadsApi::deleteThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                          const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  if (!log_->deleteThread(*caller, ThreadId{id})) {
    cb(error(drogon::k404NotFound, "no such conversation"));
    return;
  }
  // Nothing to say and no body to say it in — and the routine's history behind it is untouched.
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}


// Every conversation this account has had, as the file it walks away with — the same deliberately
// dull export the sets get: no parameters, no pagination, nothing omitted, and the turns byte for
// byte. It is a SECOND file rather than more columns on the first because a CSV row is one shape,
// and a set and a sentence are not one shape.
//
// It stays mounted on a deployment with no vendor key, where `POST /v1/gym/ask` does not exist:
// what a lifter said is theirs whether or not there is a model on our side to say it to.
void ThreadsApi::exportThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k200OK);
  response->setContentTypeCode(drogon::CT_TEXT_CSV);
  response->addHeader("Content-Disposition", "attachment; filename=\"windmill-gym-threads.csv\"");
  response->setBody(toCsv(log_->exportedThreadTurns(*caller)));
  cb(response);
}

}
