#include "products/gym/adapters/http/ThreadsApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/csv/TrainingCsv.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <string>
#include <utility>

namespace wm::gym {

ThreadsApi::ThreadsApi(std::shared_ptr<ThreadService> threads, std::shared_ptr<AuthService> auth)
    : threads_(std::move(threads)), auth_(std::move(auth)) {}


void ThreadsApi::listThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(toJson(threads_->threads(*caller))));
}

void ThreadsApi::getThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                       const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<AskThread> held = threads_->thread(*caller, ThreadId{id});
  if (!held) {
    // Absent and another account's are one answer.
    cb(error(drogon::k404NotFound, "no such conversation"));
    return;
  }
  cb(jsonResponse(toJson(*held)));
}

// The turns go with the row; the proposals it minted stay.
void ThreadsApi::deleteThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                          const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  if (!threads_->deleteThread(*caller, ThreadId{id})) {
    cb(error(drogon::k404NotFound, "no such conversation"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}


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
  response->setBody(toCsv(threads_->exportedThreadTurns(*caller)));
  cb(response);
}

}
