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


// The list is NOT an inbox: no unread count, no badge, no state a client could draw as something
// waiting. Every row is a title the lifter typed and an outcome the server observed.
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
    // Absent and another account's, told apart by nobody.
    cb(error(drogon::k404NotFound, "no such conversation"));
    return;
  }
  cb(jsonResponse(toJson(*held)));
}

// Deletes the conversation, not the consequence: the turns go with the row, the proposals it minted
// do not. An applied change stays in the routine's history and simply no longer opens a conversation.
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
  // The routine's history behind it is untouched.
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}


// Every conversation this account has had, exported like the sets: no parameters, no pagination,
// nothing omitted, the turns byte for byte. A SECOND file, because a set and a sentence are not one
// CSV shape. It stays mounted on a deployment with no vendor key, where `POST /v1/gym/ask` does not
// exist.
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
