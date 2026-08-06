#include "products/gym/adapters/http/CoachApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"

#include <optional>
#include <utility>

namespace wm::gym {

namespace {

// The refusal, in the two shapes a client needs: the sentence a lifter reads and — for the three a
// client must branch on — the machine word beside it. The rest have exactly one cause and the
// sentence is the whole of it.
drogon::HttpResponsePtr refusalOf(CoachRefusal refusal) {
  if (refusal == CoachRefusal::turnsMalformed)
    return error(drogon::k400BadRequest, "that isn't a conversation this panel can answer");
  if (refusal == CoachRefusal::questionEmpty)
    return error(drogon::k400BadRequest, "ask something about this workout");
  if (refusal == CoachRefusal::questionTooLong)
    return error(drogon::k400BadRequest, "that question is longer than this panel takes");
  if (refusal == CoachRefusal::tooManyTurns)
    return error(drogon::k400BadRequest, "this panel holds a shorter conversation than that");
  if (refusal == CoachRefusal::notEntitled)
    return error(drogon::k403Forbidden, "the coach panel is part of Windmill One",
                 "coach-not-entitled");
  if (refusal == CoachRefusal::rateLimited)
    return error(drogon::k429TooManyRequests, "that's a lot of questions at once — try again shortly",
                 "coach-rate-limited");
  if (refusal == CoachRefusal::unknownSession)
    // The code is load-bearing here in a way the other two are not: an unconfigured deployment does
    // not mount this route at all, so the client's OTHER 404 is the framework's — no code, no body.
    // Without a word to tell them apart, "this workout isn't yours" and "there is no coach here"
    // would be one answer, and the panel would print the wrong one every time it was dark.
    return error(drogon::k404NotFound, "that workout isn't in your log", "coach-no-session");
  // notConfigured. Unreachable while the route is only registered on a configured deployment, and
  // kept anyway: the honest answer if that ever stops being true is "there is no model", not a 500.
  return error(drogon::k503ServiceUnavailable, "the coach isn't available right now");
}

// One turn off the wire. `from` is the panel's own vocabulary rather than the vendor's — a lifter and
// the coach, not a user and an assistant — because this shape is gym's contract with its own client
// and nothing about it should have to change if the model behind it does.
std::optional<CoachTurn> parseTurn(const Json::Value& value) {
  if (!value.isObject() || !value["text"].isString()) return std::nullopt;
  const std::string from = value["from"].asString();
  if (from != "lifter" && from != "coach") return std::nullopt;
  return CoachTurn{from == "lifter", value["text"].asString()};
}

}  // namespace

CoachApi::CoachApi(std::shared_ptr<CoachService> coach, std::shared_ptr<AuthService> auth)
    : coach_(std::move(coach)), auth_(std::move(auth)) {}

void CoachApi::ask(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id) {
  // The email is the second binding the entitlement seam reads, so the caller is resolved whole here
  // rather than projected to an id.
  std::optional<User> caller = callerUserOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json || !(*json)["turns"].isArray()) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }

  std::vector<CoachTurn> turns;
  for (const Json::Value& value : (*json)["turns"]) {
    std::optional<CoachTurn> turn = parseTurn(value);
    if (!turn) {
      cb(error(drogon::k400BadRequest, "that isn't a conversation this panel can answer"));
      return;
    }
    turns.push_back(std::move(*turn));
  }

  // The reply lands on a worker thread, not this one — the handler is done the moment it hands the
  // callback over. Drogon is happy to be answered from anywhere; what it will not survive is four
  // handler threads all blocked on a vendor.
  coach_->ask(caller->id, caller->email.value, SessionId{id}, std::move(turns),
              [cb = std::move(cb)](CoachReply reply) {
                if (reply.refusal != CoachRefusal::none) {
                  cb(refusalOf(reply.refusal));
                  return;
                }
                if (!reply.answer.ok) {
                  // Every diagnostic — the cap, the early stop, the dead upstream — is one fact to
                  // the lifter: nothing came back. The detail went to the error tracker, where it
                  // belongs; a panel is not a place to print a stop reason.
                  cb(error(drogon::k502BadGateway, "the coach didn't answer. Ask again in a moment"));
                  return;
                }
                Json::Value steps(Json::arrayValue);
                for (const CoachStep& step : reply.answer.steps) {
                  Json::Value entry(Json::objectValue);
                  entry["tool"] = step.tool;
                  entry["failed"] = step.failed;
                  steps.append(entry);
                }
                Json::Value body(Json::objectValue);
                body["answer"] = reply.answer.answer;
                body["steps"] = steps;  // what it read, in call order — the panel draws this
                cb(jsonResponse(body));
              });
}

}
