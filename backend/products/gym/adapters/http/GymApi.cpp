#include "products/gym/adapters/http/GymApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <algorithm>
#include <charconv>
#include <optional>
#include <utility>

namespace wm::gym {

namespace {
std::optional<std::uint64_t> digitsOnlyMs(const std::string& text) {
  std::uint64_t value = 0;
  const char* last = text.data() + text.size();
  const std::from_chars_result parsed = std::from_chars(text.data(), last, value);
  if (parsed.ec != std::errc{} || parsed.ptr != last) return std::nullopt;
  return std::min(value, kMaxInstantMs);
}
}

GymApi::GymApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth)
    : log_(std::move(log)), auth_(std::move(auth)) {}

void GymApi::listExercises(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["exercises"] = toJson(log_->catalog(*caller));
  cb(jsonResponse(body));
}

void GymApi::startSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }
  // Parse and construction share one catch, and it catches ONLY InvalidTraining: a missing field,
  // a malformed id — the client's mistake, a 400. A storage failure is not the client's mistake and
  // must not wear the client's status, so it rides past this catch to the house 500 — the status a
  // flush queue retries, where 400 is the one it drops the set on. The reply is always the RESOLVED
  // session — a replay is handed its own row back, a double-tap is handed the first tap's.
  StartOutcome outcome{std::nullopt, StartError::none};
  try {
    outcome = log_->start(*caller, parseSessionStart(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that session"));
    return;
  }
  if (outcome.error == StartError::idTaken) {
    // The id is spent — by this account or another, the client is never told which. Mint a new one:
    // the old reply was a 200 for a session the store never accepted, and every set into it 404'd.
    cb(error(drogon::k409Conflict, "that session id is taken", "session-id-taken"));
    return;
  }
  if (outcome.error == StartError::alreadyOpen) {
    // Only a caller that sent `joinOpenSession: false` can reach this: it meant "create exactly this
    // session, which is not now", and this lifter has a workout in progress. The join the default
    // would have taken is the corruption — a backfill's or an import's sets filed into today's live
    // session. Its repair is neither of the other 409s': a fresh id changes nothing while a session
    // is open, so the open workout gets finished (or auto-closes at four hours) and the same body is
    // sent again. Hence its own code — a client that read the sentence would branch on prose.
    cb(error(drogon::k409Conflict, "another session is already open", "session-already-open"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.session)));
}

void GymApi::appendSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                       const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }
  AppendOutcome outcome{std::nullopt, AppendError::none};
  try {
    outcome = log_->append(*caller, SessionId{id}, parseSetWrite(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that set"));
    return;
  }
  if (outcome.error == AppendError::notFound) {
    // Absent and another's are byte-identical — a fact, not a fault.
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  if (outcome.error == AppendError::finished) {
    // Terminal for the flush queue: this set will never land here, stop retrying it. A set that
    // ALREADY landed here replays 200 with its stored row even now — the queue's whole premise.
    cb(error(drogon::k409Conflict, "that session is finished", "session-finished"));
    return;
  }
  if (outcome.error == AppendError::idTaken) {
    // The id names a row outside this session. Whose is never said — that is the same absent-is-
    // forbidden rule as the 404, applied to an id instead of a session. The queue mints a new id
    // for the set and sends it again, which is a different move from the two refusals around it —
    // hence the code: telling them apart by the sentence breaks the moment the sentence is edited.
    cb(error(drogon::k409Conflict, "that set id is already used", "set-id-taken"));
    return;
  }
  if (outcome.error == AppendError::unknownExercise) {
    // A set naming a movement no catalog holds IS the client's fact, and a permanent one — so it
    // keeps the terminal 400 while saying the true thing, instead of hiding inside "could not read".
    cb(error(drogon::k400BadRequest, "no such exercise", "unknown-exercise"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.set)));
}

void GymApi::finishSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                           const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "expected json"));
    return;
  }
  // The close runs INSIDE the catch its two sibling writes have always had: an instant this session
  // cannot end at is the client's mistake like any other, a 400 — never the 500 that used to escape
  // here, which a flush queue reads as "retry forever".
  FinishOutcome outcome{std::nullopt, FinishError::none};
  try {
    outcome = log_->finish(*caller, SessionId{id}, parseFinish(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that finish"));
    return;
  }
  if (outcome.error == FinishError::notFound) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  if (outcome.error == FinishError::badInstant) {
    // The wire bounds an instant on its own; only the stored row knows this one runs backwards.
    cb(error(drogon::k400BadRequest, "a session cannot finish before it began"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.session)));
}

void GymApi::listSessions(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  // The cursor is the previous page's LAST ROW, both halves of it — `before` its startedAt and
  // `beforeId` its id — because only the pair is unique. A bare instant cursor drops a session
  // whose start ties with another's across a page edge, and it is then in no page, ever. The two
  // halves travel together: an id with no instant names no row, so it is a bad cursor, not a
  // half-honoured one.
  LogCursor cursor{kMaxInstantMs, std::nullopt, 50};
  const std::string before = req->getParameter("before");
  const std::string beforeId = req->getParameter("beforeId");
  if (!before.empty()) {
    std::optional<std::uint64_t> parsed = digitsOnlyMs(before);
    if (!parsed) {
      cb(error(drogon::k400BadRequest, "bad cursor"));
      return;
    }
    cursor.beforeMs = *parsed;
  }
  if (!beforeId.empty()) {
    if (before.empty() || !wellFormedId(beforeId)) {
      cb(error(drogon::k400BadRequest, "bad cursor"));
      return;
    }
    cursor.beforeId = SessionId{beforeId};
  }
  const std::string requestedLimit = req->getParameter("limit");
  if (!requestedLimit.empty()) {
    int value = 0;
    const char* last = requestedLimit.data() + requestedLimit.size();
    const std::from_chars_result parsed = std::from_chars(requestedLimit.data(), last, value);
    if (parsed.ec == std::errc{} && parsed.ptr == last && value > 0)
      cursor.limit = std::min(value, 200);
  }

  Json::Value sessions(Json::arrayValue);
  for (const SessionSummary& summary : log_->log(*caller, cursor)) {
    Json::Value item = toJson(summary.session);
    item["setCount"] = summary.setCount;
    Json::Value names(Json::arrayValue);
    for (const std::string& name : summary.exerciseNames) names.append(name);
    item["exercises"] = names;
    sessions.append(item);
  }
  Json::Value body(Json::objectValue);
  body["sessions"] = sessions;
  cb(jsonResponse(body));
}

void GymApi::getSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                        const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<SessionDetail> detail = log_->detail(*caller, SessionId{id});
  if (!detail) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["session"] = toJson(detail->session);
  body["sets"] = toJson(detail->sets);
  cb(jsonResponse(body));
}

// The prefill: what this account did the last time it trained this movement, which is the number
// the logger puts on screen before the lifter touches anything.
//
//   { "exerciseId": "bench-press",
//     "session": { "id", "startedAt", "finishedAt", … },   omitted when there is no last time
//     "routine": "Bench day",                              omitted when that session was ad-hoc
//     "sets":    [ … ] }                                   omitted with the session; never empty
//
// The movement is echoed back because the client re-reads this on every movement change and a reply
// that arrives after the lifter has moved on must be discardable. A first-ever movement is answered
// 200 with the movement and nothing else — a fact, not a fault; 404 would say the movement does not
// exist, which is a different and false thing, and the client draws "First time logging this" from
// the absence. A movement no catalog holds is the ONE fault here, and it is the same fact the write
// path already names, so it keeps the same word: a client that got this id from GET /v1/gym/exercises
// cannot reach it.
void GymApi::lastTime(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  const std::string exercise = req->getParameter("exercise");
  if (exercise.empty()) {
    cb(error(drogon::k400BadRequest, "bad exercise"));
    return;
  }
  LastTimeOutcome outcome = log_->lastTime(*caller, ExerciseId{exercise});
  if (outcome.error == LastTimeError::unknownExercise) {
    cb(error(drogon::k400BadRequest, "no such exercise", "unknown-exercise"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["exerciseId"] = exercise;
  if (outcome.lastTime) {
    body["session"] = toJson(outcome.lastTime->session);
    if (!outcome.lastTime->routineName.empty()) body["routine"] = outcome.lastTime->routineName;
    body["sets"] = toJson(outcome.lastTime->sets);
  }
  cb(jsonResponse(body));
}

}
