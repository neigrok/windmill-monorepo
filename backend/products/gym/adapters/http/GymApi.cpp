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

}
