#include "products/gym/adapters/http/AskApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <utility>

namespace wm::gym {

namespace {

// The refusal in the two shapes a client needs: the sentence a lifter reads and, where a client must
// branch, the machine word beside it.
drogon::HttpResponsePtr refusalOf(AskRefusal refusal) {
  if (refusal == AskRefusal::threadMalformed)
    return error(drogon::k400BadRequest, "that isn't a conversation Ask can answer");
  if (refusal == AskRefusal::threadTaken)
    // The id names a conversation this account cannot see: REFUSED rather than appended to, because
    // the primary key spans every account. The client mints a fresh one.
    return error(drogon::k409Conflict, "that conversation id is already in use — start a new one",
                 "ask-thread-taken");
  if (refusal == AskRefusal::questionEmpty)
    return error(drogon::k400BadRequest, "ask something about your training");
  if (refusal == AskRefusal::questionTooLong)
    return error(drogon::k400BadRequest, "that question is longer than Ask takes");
  if (refusal == AskRefusal::questionUnstorable)
    // The text rule every note, movement name and routine name meets (`storableText`,
    // domain/Training.h), at Ask's door too. TERMINAL: a NUL or bytes that are not UTF-8 cannot be
    // stored however many times the body is re-sent.
    return error(drogon::k400BadRequest, "that question has characters Ask can't store");
  if (refusal == AskRefusal::tooManyTurns)
    // The client's cue to open a new thread, not to trim the old one: nothing a client sends can
    // shorten a stored thread.
    return error(drogon::k409Conflict,
                 "this conversation is as long as Ask holds. Start a new one",
                 "ask-thread-full");
  if (refusal == AskRefusal::sessionOpen)
    // The fail-closed floor under three clients that should not have offered the door at all.
    return error(drogon::k409Conflict, "finish your workout first — Ask reads a log that has stopped "
                                       "moving", "ask-session-open");
  if (refusal == AskRefusal::dailyLimit)
    // The cap said plainly, with nothing sold against it: there is no checkout in this product.
    return error(drogon::k429TooManyRequests,
                 "that's Ask for now — it answers about ten questions a day, three back to back. The "
                 "next one frees up in a couple of hours",
                 "ask-daily-limit");
  if (refusal == AskRefusal::outOfBudget)
    // Our own ceiling, said as ours. The window is trailing, so the wait is finite.
    return error(drogon::k429TooManyRequests,
                 "this account has reached its AI ceiling for the last 30 days. Ask will answer again "
                 "as that window rolls on",
                 "ask-out-of-budget");
  // notConfigured. Unreachable while the route is only registered on a configured deployment. It
  // carries its own code, because a proxy's 503 during a restart is a different fact.
  return error(drogon::k503ServiceUnavailable, "Ask isn't available right now", "ask-not-configured");
}

}  // namespace

AskApi::AskApi(std::shared_ptr<AskService> ask, std::shared_ptr<AuthService> auth)
    : ask_(std::move(ask)), auth_(std::move(auth)) {}

void AskApi::ask(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // The email is the second binding the entitlement seam reads, so the caller is resolved whole.
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  // One question into one thread: the server holds the conversation, so a client history would be a
  // second, editable copy of what was said.
  if (!json || !(*json)["thread"].isString() || !(*json)["question"].isString()) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }

  // The reply lands on a worker thread, not this one: the handler is done the moment it hands the
  // callback over, so no handler thread blocks on the vendor.
  const ThreadId thread{(*json)["thread"].asString()};
  ask_->ask(caller->id, caller->email.value, thread, (*json)["question"].asString(),
            [cb = std::move(cb), thread](AskReply reply) {
    if (reply.refusal != AskRefusal::none) {
      cb(refusalOf(reply.refusal));
      return;
    }
    if (!reply.answer.ok) {
      // Every diagnostic is one fact to the lifter: nothing came back. Nothing was stored either —
      // a question nobody answered is not a turn, so a retry into the same thread lands once.
      cb(error(drogon::k502BadGateway, "Ask didn't answer. Try again in a moment"));
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
    body["steps"] = steps;          // what it read, in call order — the client draws this
    // The SERVER's count of the rows its own tools served during this exchange, deduped by id. A
    // client renders it; no client and no model computes it.
    body["read"] = toJson(reply.read);
    // Minted during the exchange, observed at the tool rather than read out of the answer's prose.
    // The diff itself is `GET /v1/gym/proposals/{id}`.
    body["proposals"] = proposals;
    // The conversation this landed in, echoed back: the id the threads list and
    // `GET /v1/gym/threads/{id}` are read by.
    body["thread"] = thread.str();
    cb(jsonResponse(body));
  });
}

}
