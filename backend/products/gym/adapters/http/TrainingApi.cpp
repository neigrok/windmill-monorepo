#include "products/gym/adapters/http/TrainingApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/json/JsonText.h"
#include "products/gym/adapters/csv/TrainingCsv.h"
#include "products/gym/adapters/json/TrainingJson.h"

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
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

// FNV-1a, 64-bit.
std::uint64_t fold(const std::string& text) {
  std::uint64_t hash = 14695981039346656037ull;
  for (const unsigned char byte : text) {
    hash ^= byte;
    hash *= 1099511628211ull;
  }
  return hash;
}

// If-None-Match per RFC 9110: a comma-separated list of entity-tags, each optionally W/-prefixed, or
// the lone "*". Weak comparison — strip W/ from both sides and compare the quoted opaque-tags.
bool ifNoneMatchAccepts(const std::string& header, std::string_view tag) {
  if (tag.substr(0, 2) == "W/") tag.remove_prefix(2);
  std::size_t at = 0;
  while (at < header.size()) {
    std::size_t comma = header.find(',', at);
    if (comma == std::string::npos) comma = header.size();
    std::string_view entry{header.data() + at, comma - at};
    while (!entry.empty() && (entry.front() == ' ' || entry.front() == '\t')) entry.remove_prefix(1);
    while (!entry.empty() && (entry.back() == ' ' || entry.back() == '\t')) entry.remove_suffix(1);
    if (entry == "*") return true;
    if (entry.substr(0, 2) == "W/") entry.remove_prefix(2);
    if (entry == tag) return true;
    at = comma + 1;
  }
  return false;
}
}

TrainingApi::TrainingApi(std::shared_ptr<TrainingService> training,
                         std::shared_ptr<AuthService> auth, std::string appBaseUrl)
    : training_(std::move(training)), auth_(std::move(auth)), appBaseUrl_(std::move(appBaseUrl)) {}

void TrainingApi::startSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
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
  // Catches only InvalidTraining: a storage failure must ride past to the house 500. A replay is
  // handed its own row back.
  StartOutcome outcome{std::nullopt, StartError::none};
  try {
    outcome = training_->start(*caller, parseSessionStart(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that session"));
    return;
  }
  if (outcome.error == StartError::idTaken) {
    // The id is spent; whose account holds it is never said.
    cb(error(drogon::k409Conflict, "that session id is taken", "session-id-taken"));
    return;
  }
  if (outcome.error == StartError::unknownRoutine) {
    // Never-existed and someone else's are one answer.
    cb(error(drogon::k404NotFound, "no such routine"));
    return;
  }
  if (outcome.error == StartError::clockAhead) {
    // Its own code: a flush queue treats every other 400 as terminal.
    cb(error(drogon::k400BadRequest,
             "this device's clock is " + std::to_string((outcome.clockAheadMs + 59'999) / 60'000) +
                 " minutes ahead of the log — a workout cannot start in the future. Check the "
                 "clock and start again.",
             "clock-ahead"));
    return;
  }
  if (outcome.error == StartError::alreadyOpen) {
    // Only a caller that sent `joinOpenSession: false` reaches this.
    cb(error(drogon::k409Conflict, "another session is already open", "session-already-open"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.session)));
}

void TrainingApi::appendSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
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
    outcome = training_->append(*caller, SessionId{id}, parseSetWrite(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that set"));
    return;
  }
  if (outcome.error == AppendError::notFound) {
    // Absent and another account's are byte-identical.
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  if (outcome.error == AppendError::finished) {
    // Terminal for the flush queue; a set that already landed replays 200 with its stored row.
    cb(error(drogon::k409Conflict, "that session is finished", "session-finished"));
    return;
  }
  if (outcome.error == AppendError::idTaken) {
    // The id names a row outside this session; whose is never said.
    cb(error(drogon::k409Conflict, "that set id is already used", "set-id-taken"));
    return;
  }
  if (outcome.error == AppendError::unknownExercise) {
    cb(error(drogon::k400BadRequest, "no such exercise", "unknown-exercise"));
    return;
  }
  if (outcome.error == AppendError::deleted) {
    // The append is a replay of a deleted set: drop it. Not `set-id-taken`, whose repair would put
    // that set back in the log.
    cb(error(drogon::k409Conflict, "that set was deleted", "set-deleted"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.set)));
}

// A fix names only the numbers that were wrong and answers the stored row, so a retry reads back the
// same values rather than compounding a change.
void TrainingApi::fixSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id,
                    const std::string& setId) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "expected json", "fix-unreadable"));
    return;
  }
  std::optional<Set> fixed;
  try {
    fixed = training_->fixSet(*caller, SessionId{id}, SetId{setId}, parseSetFix(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that fix", "fix-unreadable"));
    return;
  }
  if (!fixed) {
    // Gone, another account's and in a different workout are one answer, byte for byte, so a set id
    // cannot be probed for existence.
    cb(error(drogon::k404NotFound, "no such set", "set-not-found"));
    return;
  }
  cb(jsonResponse(toJson(*fixed)));
}

// Refuses nothing: the same request twice gets the same 204.
void TrainingApi::deleteSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id,
                       const std::string& setId) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  training_->deleteSet(*caller, SessionId{id}, SetId{setId});
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

void TrainingApi::finishSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
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
  FinishOutcome outcome{std::nullopt, FinishError::none};
  try {
    outcome = training_->finish(*caller, SessionId{id}, parseFinish(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that finish"));
    return;
  }
  if (outcome.error == FinishError::notFound) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  if (outcome.error == FinishError::badInstant) {
    cb(error(drogon::k400BadRequest, "a session cannot finish before it began"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.session)));
}

void TrainingApi::listSessions(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  // The cursor is the previous page's last row, both halves: only the (startedAt, id) pair is unique.
  // An id with no instant is a bad cursor, not a half-honoured one.
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
  for (const LogRow& row : training_->log(*caller, cursor)) sessions.append(toJson(row));
  Json::Value body(Json::objectValue);
  body["sessions"] = sessions;
  cb(jsonResponse(body));
}

void TrainingApi::getSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                        const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<SessionDetail> detail = training_->detail(*caller, SessionId{id});
  if (!detail) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  // A weak tag over three terms: both session instants and a fold of the rendered sets. startedAt
  // leads, so a session discarded and recreated under the same id never 304s as the dead workout.
  const Json::Value sets = toJson(detail->sets);
  const std::string tag = "W/\"" + std::to_string(detail->session.startedAtMs) + "-" +
                          std::to_string(detail->session.finishedAtMs.value_or(0)) + "-" +
                          std::to_string(fold(dump(sets))) + "\"";
  if (ifNoneMatchAccepts(req->getHeader("if-none-match"), tag)) {
    auto unchanged = drogon::HttpResponse::newHttpResponse();
    unchanged->setStatusCode(drogon::k304NotModified);
    // CT_NONE maps to the empty mime string, which drogon renders as no content-type line at all.
    unchanged->setContentTypeCode(drogon::CT_NONE);
    unchanged->addHeader("ETag", tag);
    cb(unchanged);
    return;
  }
  Json::Value body(Json::objectValue);
  body["session"] = toJson(detail->session);
  body["sets"] = sets;
  drogon::HttpResponsePtr response = jsonResponse(body);
  response->addHeader("ETag", tag);
  cb(response);
}

void TrainingApi::reviewSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                           const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<Review> review = training_->review(*caller, SessionId{id});
  if (!review) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  cb(jsonResponse(toJson(*review)));
}

void TrainingApi::discardSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                            const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  DiscardOutcome outcome = training_->discard(*caller, SessionId{id});
  if (outcome == DiscardOutcome::notFound) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  if (outcome == DiscardOutcome::open) {
    cb(error(drogon::k409Conflict, "that session is still running", "session-open"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

//   { "exerciseId": "bench-press",
//     "session": { "id", "startedAt", "finishedAt", … },   omitted when there is no last time
//     "routine": "Bench day",                              omitted when that session was ad-hoc
//     "sets":    [ … ] }                                   omitted with the session; never empty
//
// A first-ever movement answers 200 with the movement echoed back and nothing else.
void TrainingApi::lastTime(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
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
  LastTimeOutcome outcome = training_->lastTime(*caller, ExerciseId{exercise});
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

// A movement absent here has never been logged.
void TrainingApi::lastSets(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["movements"] = toJson(training_->lastSets(*caller));
  cb(jsonResponse(body));
}

void TrainingApi::stats(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(toJson(training_->statistics(*caller))));
}

void TrainingApi::exportSets(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k200OK);
  response->setContentTypeCode(drogon::CT_TEXT_CSV);
  response->addHeader("Content-Disposition", "attachment; filename=\"windmill-gym-sets.csv\"");
  response->setBody(toCsv(training_->exportedSets(*caller)));
  cb(response);
}

// Idempotent on the session, not on a client-minted id. An expired share is replaced, so the reply
// always carries the expiry of the link it hands over.
void TrainingApi::shareSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                          const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<SessionShare> share = training_->share(*caller, SessionId{id});
  if (!share) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["token"] = share->token;
  body["url"] = shareUrl(appBaseUrl_, share->token);
  body["expiresAt"] = Json::Value::UInt64(share->expiresAtMs);
  cb(jsonResponse(body));
}

// The row is the capability, so revoking deletes it. Nothing to revoke gets the absent-session 404.
void TrainingApi::revokeShare(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                         const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  if (!training_->revokeShare(*caller, SessionId{id})) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

// Resolves no caller: the path token is the whole credential. Revoked, expired and never-minted
// answer one 404, byte for byte, and the body names no account and holds no id at any depth.
void TrainingApi::sharedSession(const drogon::HttpRequestPtr&, HttpCallback&& cb,
                           const std::string& token) {
  std::optional<SharedSession> shared = training_->shared(token);
  if (!shared) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  cb(jsonResponse(toJson(*shared)));
}

}
