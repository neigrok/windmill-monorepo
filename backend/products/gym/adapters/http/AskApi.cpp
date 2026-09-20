#include "products/gym/adapters/http/AskApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <drogon/HttpAppFramework.h>
#include <mutex>
#include "platform/adapters/json/JsonText.h"
#include <utility>

namespace wm::gym {

namespace {

drogon::HttpResponsePtr refusalOf(AskRefusal refusal) {
  if (refusal == AskRefusal::threadMalformed)
    return error(drogon::k400BadRequest, "that isn’t a conversation Coach can answer");
  if (refusal == AskRefusal::threadTaken)
    // The thread primary key spans every account, so a taken id is refused, never appended to.
    return error(drogon::k409Conflict, "that conversation id is already in use — start a new one",
                 "ask-thread-taken");
  if (refusal == AskRefusal::questionEmpty)
    return error(drogon::k400BadRequest, "ask something about your training");
  if (refusal == AskRefusal::questionTooLong)
    return error(drogon::k400BadRequest, "that question is longer than Coach takes");
  if (refusal == AskRefusal::questionUnstorable)
    // Terminal: a NUL or non-UTF-8 bytes stay unstorable however often the body is re-sent.
    return error(drogon::k400BadRequest, "that question has characters Coach can’t store");
  if (refusal == AskRefusal::requestMalformed)
    return error(drogon::k400BadRequest, "that request id cannot be used", "ask-request-malformed");
  if (refusal == AskRefusal::requestConflict)
    return error(drogon::k409Conflict, "that request already contains a different question", "ask-request-conflict");
  if (refusal == AskRefusal::attachmentInvalid)
    return error(drogon::k400BadRequest, "upload a valid photo for this conversation", "ask-attachment-invalid");
  if (refusal == AskRefusal::busy)
    return error(drogon::k503ServiceUnavailable, "Coach is busy. Try again in a moment", "ask-busy");
  if (refusal == AskRefusal::generationActive)
    return error(drogon::k409Conflict, "Coach is still answering in this conversation", "ask-generation-active");
  if (refusal == AskRefusal::sessionOpen)
    return error(drogon::k409Conflict,
                 "finish your workout first — Coach reads a log that has stopped moving",
                 "ask-session-open");
  if (refusal == AskRefusal::dailyLimit)
    // Ten a day on a steady refill is one question every two and a half hours.
    return error(drogon::k429TooManyRequests, "the next question frees up in a couple of hours",
                 "ask-daily-limit");
  if (refusal == AskRefusal::outOfBudget)
    return error(drogon::k429TooManyRequests,
                 "this account has reached its AI ceiling for the last 30 days. Coach will answer "
                 "again as that window rolls on",
                 "ask-out-of-budget");
  // notConfigured: its own code, so a proxy's 503 during a restart stays a different fact.
  return error(drogon::k503ServiceUnavailable,
               "Coach isn’t part of this Windmill. Your log is still yours to read.",
               "ask-not-configured");
}

class CoachStream : public std::enable_shared_from_this<CoachStream> {
public:
  CoachStream(drogon::ResponseStreamPtr stream, std::shared_ptr<AskService> ask, UserId user, ThreadId thread, std::string requestId)
      : stream_(std::move(stream)), ask_(std::move(ask)), user_(std::move(user)), thread_(std::move(thread)), requestId_(std::move(requestId)) {}

  void poll() {
    {
      std::lock_guard lock(mutex_);
      if (closed_) return;
    }
    ask_->readGeneration(user_, thread_, requestId_, [self = shared_from_this()](bool available, std::optional<AskGeneration> generation) {
      {
        std::lock_guard lock(self->mutex_);
        if (self->closed_) return;
        if (!available) {
          self->stream_->send("event: error\ndata: {\"error\":\"Could not read Coach state\",\"status\":503}\n\n");
          self->stream_->close();
          self->closed_ = true;
          return;
        }
        if (generation && (generation->status == "running" || self->accepted_)) self->snapshot(*generation);
        if (!self->closed_ && self->tick_++ % 15 == 0 && !self->stream_->send(": heartbeat\n\n")) self->closed_ = true;
        if (self->closed_) return;
      }
      drogon::app().getLoop()->runAfter(1.0, [self] { self->poll(); });
    });
  }

  void finish(const AskReply& reply) {
    std::lock_guard lock(mutex_);
    if (closed_) return;
    accepted_ = true;
    if (reply.generation && reply.refusal == AskRefusal::none) snapshot(*reply.generation);
    if (reply.refusal != AskRefusal::none) {
      const auto response = refusalOf(reply.refusal);
      Json::Value body = *response->getJsonObject();
      body["status"] = static_cast<int>(response->getStatusCode());
      if (reply.generation) {
        body["thread"] = thread_.str();
        body["generation"] = toJson(*reply.generation);
        body["results"] = body["generation"]["results"];
      }
      stream_->send("event: error\ndata: " + dump(body) + "\n\n");
      stream_->close();
      closed_ = true;
      return;
    }
    if (!reply.generation) {
      stream_->send("event: error\ndata: {\"error\":\"Coach did not answer\",\"status\":502}\n\n");
      stream_->close();
      closed_ = true;
    }
  }

private:
  void snapshot(const AskGeneration& generation) {
    if (!seen_ || generation.revision > revision_) {
      Json::Value body(Json::objectValue);
      body["thread"] = thread_.str();
      body["generation"] = toJson(generation);
      seen_ = true;
      revision_ = generation.revision;
      if (!stream_->send("id: " + generation.id + ":" + std::to_string(revision_) + "\nevent: snapshot\ndata: " + dump(body) + "\n\n")) closed_ = true;
    }
    if (generation.status != "running") { stream_->close(); closed_ = true; }
  }
  std::mutex mutex_;
  drogon::ResponseStreamPtr stream_;
  std::shared_ptr<AskService> ask_;
  UserId user_;
  ThreadId thread_;
  std::string requestId_;
  std::uint64_t revision_ = 0;
  unsigned tick_ = 0;
  bool seen_ = false;
  bool accepted_ = false;
  bool closed_ = false;
};

}  // namespace

AskApi::AskApi(std::shared_ptr<AskService> ask, std::shared_ptr<AuthService> auth)
    : ask_(std::move(ask)), auth_(std::move(auth)) {}

void AskApi::ask(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json || !(*json)["thread"].isString() || (json->isMember("question") && !(*json)["question"].isString())) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }

  if (json->isMember("requestId") && !(*json)["requestId"].isString()) {
    cb(error(drogon::k400BadRequest, "expected a request id"));
    return;
  }
  const std::string requestId = json->get("requestId", "").asString();
  std::vector<std::string> attachments;
  if (json->isMember("attachmentIds")) {
    if (!(*json)["attachmentIds"].isArray() || (*json)["attachmentIds"].size() > 1) {
      cb(error(drogon::k400BadRequest, "attach at most one photo")); return;
    }
    for (const auto& id : (*json)["attachmentIds"]) {
      if (!id.isString()) { cb(error(drogon::k400BadRequest, "invalid attachment id")); return; }
      attachments.push_back(id.asString());
    }
  }
  const std::string question = json->get("question", "").asString();
  if (json->get("stream", false).isBool() && json->get("stream", false).asBool()) {
    if (requestId.empty()) { cb(error(drogon::k400BadRequest, "streaming requires a stable request id")); return; }
    const ThreadId thread{(*json)["thread"].asString()};
    auto response = drogon::HttpResponse::newAsyncStreamResponse(
        [ask = ask_, caller = *caller, thread, question, requestId, attachments](drogon::ResponseStreamPtr stream) {
          auto reply = std::make_shared<CoachStream>(std::move(stream), ask, caller.id, thread, requestId);
          ask->ask(caller.id, caller.email.value, thread, question,
                   [reply](AskReply answer) { reply->finish(answer); }, requestId, attachments);
          reply->poll();
        }, true);
    response->setContentTypeString("text/event-stream");
    response->addHeader("cache-control", "no-cache");
    response->addHeader("x-accel-buffering", "no");
    cb(response);
    return;
  }

  // The reply lands on a worker thread: no handler thread blocks on the vendor.
  const ThreadId thread{(*json)["thread"].asString()};
  ask_->ask(caller->id, caller->email.value, thread, question,
            [cb = std::move(cb), thread](AskReply reply) {
    if (reply.refusal != AskRefusal::none) {
      auto response = refusalOf(reply.refusal);
      if (reply.generation) {
        Json::Value body = *response->getJsonObject();
        body["thread"] = thread.str();
        body["generation"] = toJson(*reply.generation);
        body["results"] = body["generation"]["results"];
        const auto status = response->getStatusCode();
        response = jsonResponse(body);
        response->setStatusCode(status);
      }
      cb(response);
      return;
    }
    if (reply.generation && reply.generation->status == "running") {
      Json::Value body(Json::objectValue);
      body["thread"] = thread.str();
      body["generation"] = toJson(*reply.generation);
      body["results"] = body["generation"]["results"];
      auto response = jsonResponse(body);
      response->setStatusCode(drogon::k202Accepted);
      cb(response);
      return;
    }
    if (!reply.answer.ok) {
      Json::Value body(Json::objectValue);
      body["error"] = "Coach didn’t answer. Try again in a moment";
      body["thread"] = thread.str();
      if (reply.generation) {
        body["generation"] = toJson(*reply.generation);
        body["results"] = body["generation"]["results"];
      }
      auto response = jsonResponse(body);
      response->setStatusCode(drogon::k502BadGateway);
      cb(response);
      return;
    }
    Json::Value proposals(Json::arrayValue);
    for (const std::string& id : reply.proposals) proposals.append(id);

    Json::Value body(Json::objectValue);
    body["answer"] = reply.answer.answer;
    body["steps"] = toJson(reply.answer.steps);
    // Rows the server's own tools served during this exchange, deduped by id.
    body["read"] = toJson(reply.read);
    body["proposals"] = proposals;
    body["thread"] = thread.str();
    if (reply.generation) {
      body["generation"] = toJson(*reply.generation);
      body["results"] = body["generation"]["results"];
    }
    if (reply.receipt) body["receipt"] = toJson(*reply.receipt);
    cb(jsonResponse(body));
  }, requestId, attachments);
}

}
