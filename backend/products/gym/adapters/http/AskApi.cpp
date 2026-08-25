#include "products/gym/adapters/http/AskApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
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
  if (refusal == AskRefusal::tooManyTurns)
    // Four questions: a question and its answer are two turns against kMaxThreadTurns (8).
    return error(drogon::k409Conflict,
                 "this conversation holds four questions — start a new one",
                 "ask-thread-full");
  if (refusal == AskRefusal::sessionOpen)
    return error(drogon::k409Conflict,
                 "finish your workout first — Coach reads a log that has stopped moving",
                 "ask-session-open");
  if (refusal == AskRefusal::dailyLimit)
    // Says what to do next, not the rule again: the allowance itself is drawn above the composer
    // by every client. True rather than approximate — ten a day on a steady refill is one every
    // two and a half hours (AskRation).
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
  if (!json || !(*json)["thread"].isString() || !(*json)["question"].isString()) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }

  // The reply lands on a worker thread: no handler thread blocks on the vendor.
  const ThreadId thread{(*json)["thread"].asString()};
  ask_->ask(caller->id, caller->email.value, thread, (*json)["question"].asString(),
            [cb = std::move(cb), thread](AskReply reply) {
    if (reply.refusal != AskRefusal::none) {
      cb(refusalOf(reply.refusal));
      return;
    }
    if (!reply.answer.ok) {
      // Nothing is stored on failure, so a retry into the same thread lands once.
      cb(error(drogon::k502BadGateway, "Coach didn’t answer. Try again in a moment"));
      return;
    }
    Json::Value steps(Json::arrayValue);
    for (const AskStep& step : reply.answer.steps) {
      Json::Value entry(Json::objectValue);
      entry["tool"] = step.tool;
      entry["failed"] = step.failed;
      steps.append(entry);
    }
    Json::Value proposals(Json::arrayValue);
    for (const std::string& id : reply.proposals) proposals.append(id);

    Json::Value body(Json::objectValue);
    body["answer"] = reply.answer.answer;
    body["steps"] = steps;          // tools called, in call order
    // Rows the server's own tools served during this exchange, deduped by id.
    body["read"] = toJson(reply.read);
    body["proposals"] = proposals;
    body["thread"] = thread.str();
    cb(jsonResponse(body));
  });
}

}
