#include "products/gym/adapters/http/ThreadsApi.h"
#include "products/gym/adapters/http/CoachImage.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <charconv>
#include <string>
#include <utility>

namespace wm::gym {

ThreadsApi::ThreadsApi(std::shared_ptr<ThreadService> threads, std::shared_ptr<AuthService> auth, std::shared_ptr<AskService> ask)
    : threads_(std::move(threads)), auth_(std::move(auth)), ask_(std::move(ask)) { uploads_.start(); }


void ThreadsApi::listThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  const std::string limitText = req->getParameter("limit");
  const std::string cursorText = req->getParameter("cursor");
  if (limitText.empty() && cursorText.empty()) {
    cb(jsonResponse(toJson(threads_->threads(*caller))));
    return;
  }
  ThreadCursor cursor;
  if (!limitText.empty()) {
    auto parsed = std::from_chars(limitText.data(), limitText.data() + limitText.size(), cursor.limit);
    if (parsed.ec != std::errc{} || parsed.ptr != limitText.data() + limitText.size() || cursor.limit < 1 || cursor.limit > 200) {
      cb(error(drogon::k400BadRequest, "choose a page size from 1 to 200")); return;
    }
  }
  if (!cursorText.empty()) {
    const auto split = cursorText.find(':');
    if (split == std::string::npos) { cb(error(drogon::k400BadRequest, "invalid conversation cursor")); return; }
    const auto parsed = std::from_chars(cursorText.data(), cursorText.data() + split, cursor.beforeMs);
    cursor.beforeId = cursorText.substr(split + 1);
    if (parsed.ec != std::errc{} || parsed.ptr != cursorText.data() + split || !cursor.beforeMs || !wellFormedId(cursor.beforeId)) {
      cb(error(drogon::k400BadRequest, "invalid conversation cursor")); return;
    }
  }
  const int limit = cursor.limit++;
  auto page = threads_->threads(*caller, cursor);
  Json::Value next;
  if (page.size() > static_cast<std::size_t>(limit)) {
    page.resize(limit);
    next = std::to_string(page.back().askedAtMs) + ":" + page.back().id.str();
  }
  Json::Value body = toJson(page);
  body["nextCursor"] = next;
  cb(jsonResponse(body));
}

void ThreadsApi::getThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                       const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  const std::string limitText = req->getParameter("limit");
  const std::string beforeText = req->getParameter("before");
  int limit = 50;
  std::uint64_t before = 0;
  if (!limitText.empty()) {
    const auto parsed = std::from_chars(limitText.data(), limitText.data() + limitText.size(), limit);
    if (parsed.ec != std::errc{} || parsed.ptr != limitText.data() + limitText.size() || limit < 1 || limit > 200) {
      cb(error(drogon::k400BadRequest, "choose a page size from 1 to 200")); return;
    }
  }
  if (!beforeText.empty()) {
    const auto parsed = std::from_chars(beforeText.data(), beforeText.data() + beforeText.size(), before);
    if (parsed.ec != std::errc{} || parsed.ptr != beforeText.data() + beforeText.size() || !before) {
      cb(error(drogon::k400BadRequest, "invalid message cursor")); return;
    }
  }
  const bool paged = !limitText.empty() || !beforeText.empty();
  std::optional<AskThread> held = paged
      ? threads_->thread(*caller, ThreadId{id}, before, limit)
      : threads_->thread(*caller, ThreadId{id});
  if (!held) {
    // Absent and another account's are one answer.
    cb(error(drogon::k404NotFound, "no such conversation"));
    return;
  }
  Json::Value body = toJson(*held);
  if (paged) body["nextCursor"] = held->nextCursor.empty() ? Json::Value{} : Json::Value(held->nextCursor);
  if (!body.isMember("turns")) body["turns"] = Json::Value(Json::arrayValue);
  cb(jsonResponse(body));
}

// The turns go with the row; the proposals it minted stay.
void ThreadsApi::deleteThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                          const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  try {
    if (!threads_->deleteThread(*caller, ThreadId{id})) {
      cb(error(drogon::k404NotFound, "no such conversation"));
      return;
    }
  } catch (const ThreadBusy&) {
    cb(error(drogon::k409Conflict, "wait for Coach to finish before deleting this conversation", "ask-generation-active"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}


void ThreadsApi::putImage(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& thread, const std::string& id) {
  const auto caller = callerOf(req, *auth_);
  if (!caller) { cb(error(drogon::k401Unauthorized, "sign in to upload a photo")); return; }
  if (!wellFormedId(thread) || !wellFormedId(id)) { cb(error(drogon::k400BadRequest, "invalid attachment identity")); return; }
  if (req->body().size() > kMaxCoachImageBytes) { cb(error(drogon::k413RequestEntityTooLarge, "choose a photo smaller than 5 MiB")); return; }
  if (uploadCount_.fetch_add(1) >= 4) {
    --uploadCount_;
    cb(error(drogon::k429TooManyRequests, "photo uploads are busy; try again shortly", "ask-image-busy"));
    return;
  }
  uploads_.getNextLoop()->queueInLoop([this, req, caller = *caller, thread, id, cb = std::move(cb)] {
    const auto upload = [&]() -> drogon::HttpResponsePtr {
      const auto image = decodeCoachImage(id, req->getHeader("content-type"), req->body());
      if (!image) return error(drogon::k400BadRequest, "choose a valid JPEG or PNG photo no larger than 4096 pixels per edge");
      const auto outcome = threads_->putImage(caller, ThreadId{thread}, *image);
      if (outcome == ImageWriteError::notFound) return error(drogon::k404NotFound, "no such conversation");
      if (outcome == ImageWriteError::idTaken) return error(drogon::k409Conflict, "that attachment id is already in use");
      if (outcome == ImageWriteError::dailyLimit) return error(drogon::k429TooManyRequests, "photo uploads are full for today", "ask-image-limit");
      Json::Value body(Json::objectValue);
      body["attachment"] = toJson(image->attachment);
      return jsonResponse(body);
    };
    drogon::HttpResponsePtr response;
    try { response = upload(); }
    catch (const std::exception&) { response = error(drogon::k503ServiceUnavailable, "photo could not be saved; try again shortly"); }
    --uploadCount_;
    cb(response);
  });
}

void ThreadsApi::getImage(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& thread, const std::string& id) {
  const auto caller = callerOf(req, *auth_);
  if (!caller) { cb(error(drogon::k401Unauthorized, "sign in to open a photo")); return; }
  const auto image = threads_->image(*caller, ThreadId{thread}, id);
  if (!image) { cb(error(drogon::k404NotFound, "no such photo")); return; }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setContentTypeString(image->attachment.mediaType);
  response->addHeader("cache-control", "private, no-store");
  response->addHeader("x-content-type-options", "nosniff");
  response->setBody(image->data);
  cb(response);
}

void ThreadsApi::stopGeneration(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& thread, const std::string& requestId) {
  const auto caller = callerOf(req, *auth_);
  if (!caller) { cb(error(drogon::k401Unauthorized, "sign in to stop Coach")); return; }
  const auto generation = ask_ ? ask_->stop(*caller, ThreadId{thread}, requestId)
                               : threads_->stopGeneration(*caller, ThreadId{thread}, requestId);
  if (!generation) { cb(error(drogon::k404NotFound, "no such answer")); return; }
  Json::Value body(Json::objectValue);
  body["thread"] = thread;
  body["generation"] = toJson(*generation);
  cb(jsonResponse(body));
}

}
