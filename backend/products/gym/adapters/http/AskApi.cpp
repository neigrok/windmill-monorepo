#include "products/gym/adapters/http/AskApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <optional>
#include <utility>

namespace wm::gym {

namespace {

// The refusal, in the two shapes a client needs: the sentence a lifter reads and — for the three a
// client must branch on — the machine word beside it. The rest have exactly one cause and the
// sentence is the whole of it.
drogon::HttpResponsePtr refusalOf(AskRefusal refusal) {
  if (refusal == AskRefusal::threadMalformed)
    return error(drogon::k400BadRequest, "that isn't a conversation Ask can answer");
  if (refusal == AskRefusal::threadTaken)
    // The id names a conversation this account cannot see. It is REFUSED rather than appended to,
    // for the reason every client-minted id in this product is: the primary key spans every account,
    // so an id somebody else holds must never be quietly written into. The client mints a fresh one.
    return error(drogon::k409Conflict, "that conversation id is already in use — start a new one",
                 "ask-thread-taken");
  if (refusal == AskRefusal::questionEmpty)
    return error(drogon::k400BadRequest, "ask something about your training");
  if (refusal == AskRefusal::questionTooLong)
    return error(drogon::k400BadRequest, "that question is longer than Ask takes");
  if (refusal == AskRefusal::questionUnstorable)
    // The one text rule every note, movement name and routine name in gym already meets
    // (`storableText`, domain/Training.h), said at Ask's door too — because this question becomes a
    // title we promised is the lifter's words byte for byte. TERMINAL, like every other 400 here: a
    // NUL or bytes that are not UTF-8 cannot be stored however many times the body is re-sent, and
    // the alternative was a house 500 that every client queue retries forever.
    return error(drogon::k400BadRequest, "that question has characters Ask can't store");
  if (refusal == AskRefusal::tooManyTurns)
    // This conversation is full. It is the CLIENT's cue to open a new thread, not to trim the old
    // one — the thread is the server's now, and nothing a client sends can shorten it.
    return error(drogon::k409Conflict,
                 "this conversation is as long as Ask holds. Start a new one",
                 "ask-thread-full");
  if (refusal == AskRefusal::sessionOpen)
    // The design's line, enforced rather than remembered: a lifter between sets is training, and the
    // log is the thing in front of them. The client should not have offered the door at all, so this
    // is the fail-closed floor under three clients rather than a sentence anybody expects to read.
    return error(drogon::k409Conflict, "finish your workout first — Ask reads a log that has stopped "
                                       "moving", "ask-session-open");
  if (refusal == AskRefusal::dailyLimit)
    // The cap said plainly, with nothing sold against it. There is no checkout in this product, so an
    // upgrade offered here would advertise a purchase that answers 503.
    return error(drogon::k429TooManyRequests,
                 "that's Ask for now — it answers about ten questions a day, three back to back. The "
                 "next one frees up in a couple of hours",
                 "ask-daily-limit");
  if (refusal == AskRefusal::outOfBudget)
    // OUR ceiling, said as ours. The window is trailing, so the wait is real and finite rather than a
    // month's silence.
    return error(drogon::k429TooManyRequests,
                 "this account has reached its AI ceiling for the last 30 days. Ask will answer again "
                 "as that window rolls on",
                 "ask-out-of-budget");
  // notConfigured. Unreachable while the route is only registered on a configured deployment, and
  // kept anyway: the honest answer if that ever stops being true is "there is no model", not a 500 —
  // and it carries its own code, because a proxy's 503 during a restart is a different fact a
  // client must not read as "Ask isn't switched on here" for the rest of its session.
  return error(drogon::k503ServiceUnavailable, "Ask isn't available right now", "ask-not-configured");
}

}  // namespace

AskApi::AskApi(std::shared_ptr<AskService> ask, std::shared_ptr<AuthService> auth)
    : ask_(std::move(ask)), auth_(std::move(auth)) {}

void AskApi::ask(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  // The email is the second binding the entitlement seam reads, so the caller is resolved whole here
  // rather than projected to an id.
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  // ONE QUESTION INTO ONE THREAD. W7 took the whole conversation in this body, because W7 stored
  // none of it; the server holds the thread now, so a client history would be a second, editable
  // copy of what was said — and the thread a lifter reads back six weeks later has to be the one the
  // model actually saw.
  if (!json || !(*json)["thread"].isString() || !(*json)["question"].isString()) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }

  // The reply lands on a worker thread, not this one — the handler is done the moment it hands the
  // callback over. Drogon is happy to be answered from anywhere; what it will not survive is four
  // handler threads all blocked on a vendor.
  const ThreadId thread{(*json)["thread"].asString()};
  ask_->ask(caller->id, caller->email.value, thread, (*json)["question"].asString(),
            [cb = std::move(cb), thread](AskReply reply) {
    if (reply.refusal != AskRefusal::none) {
      cb(refusalOf(reply.refusal));
      return;
    }
    if (!reply.answer.ok) {
      // Every diagnostic — the cap, the early stop, the dead upstream — is one fact to the lifter:
      // nothing came back. The detail went to the error tracker, where it belongs; a chat is not a
      // place to print a stop reason. Nothing was stored either: a question nobody answered is not a
      // turn, so the retry sends the same question into the same thread and it lands once.
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
    // The read line, and it is the SERVER's count of the rows its own tools served during this
    // exchange, deduped by id. A client renders it; no client, and no model, computes it.
    body["read"] = toJson(reply.read);
    // Minted during the exchange, observed at the tool rather than read out of the answer's prose.
    // The diff itself is `GET /v1/gym/proposals/{id}` — the same object, the same screen and the same
    // atomic apply an agent's proposal arrives on.
    body["proposals"] = proposals;
    // The conversation this landed in, echoed back. The client minted the id, so this confirms the
    // thread the turns were appended to rather than announcing one — and it is the id the threads
    // list and `GET /v1/gym/threads/{id}` are read by.
    body["thread"] = thread.str();
    cb(jsonResponse(body));
  });
}

}
