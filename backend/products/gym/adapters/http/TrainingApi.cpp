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

// FNV-1a, 64-bit, over the bytes the session read is about to write, so the ETag covers a
// correction that moves no count and no instant.
std::uint64_t fold(const std::string& text) {
  std::uint64_t hash = 14695981039346656037ull;
  for (const unsigned char byte : text) {
    hash ^= byte;
    hash *= 1099511628211ull;
  }
  return hash;
}

// If-None-Match per RFC 9110 §13.1.2: a comma-separated list of entity-tags, each optionally
// W/-prefixed, or the lone "*". The comparison is the WEAK one — strip W/ from both sides and
// compare the quoted opaque-tags byte for byte.
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
  // Catches ONLY InvalidTraining: a storage failure must ride past to the house 500. The reply is
  // always the RESOLVED session — a replay is handed its own row back.
  StartOutcome outcome{std::nullopt, StartError::none};
  try {
    outcome = training_->start(*caller, parseSessionStart(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that session"));
    return;
  }
  if (outcome.error == StartError::idTaken) {
    // The id is spent — by this account or another, the client is never told which.
    cb(error(drogon::k409Conflict, "that session id is taken", "session-id-taken"));
    return;
  }
  if (outcome.error == StartError::unknownRoutine) {
    // This account cannot read that routine; never-existed and someone else's are one answer.
    cb(error(drogon::k404NotFound, "no such routine"));
    return;
  }
  if (outcome.error == StartError::clockAhead) {
    // A workout that began in the server's future is refused rather than stored. Its own code,
    // because a flush queue treats every 400 as terminal.
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
    // Absent and another's are byte-identical — a fact, not a fault.
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  if (outcome.error == AppendError::finished) {
    // Terminal for the flush queue. A set that ALREADY landed replays 200 with its stored row.
    cb(error(drogon::k409Conflict, "that session is finished", "session-finished"));
    return;
  }
  if (outcome.error == AppendError::idTaken) {
    // The id names a row outside this session; whose is never said.
    cb(error(drogon::k409Conflict, "that set id is already used", "set-id-taken"));
    return;
  }
  if (outcome.error == AppendError::unknownExercise) {
    // A set naming a movement no catalog holds is a terminal 400 with its own word.
    cb(error(drogon::k400BadRequest, "no such exercise", "unknown-exercise"));
    return;
  }
  if (outcome.error == AppendError::deleted) {
    // The id names a set this lifter DELETED, so this append is a replay: drop it. Not
    // `set-id-taken`, whose repair would put a deleted set back in the log.
    cb(error(drogon::k409Conflict, "that set was deleted", "set-deleted"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.set)));
}

// PATCH and not PUT: a fix names the number that was wrong and nothing else. It answers the STORED
// row, so a retry whose reply was lost reads back the same values rather than compounding a change.
// It never touches the session's frozen plan or the routine it came from.
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
    // One word for every way a correction can be unreadable. A storage failure is NOT this and
    // rides past the catch to the house 500.
    cb(error(drogon::k400BadRequest, "could not read that fix", "fix-unreadable"));
    return;
  }
  if (!fixed) {
    // Gone, never this account's, or in a different workout — one answer for all three, byte for
    // byte, so a set id cannot be probed for existence.
    cb(error(drogon::k404NotFound, "no such set", "set-not-found"));
    return;
  }
  cb(jsonResponse(toJson(*fixed)));
}

// Refuses NOTHING: a set that was never here does not stand either, so a client whose reply was lost
// sends the same request again and gets the same 204. The row moves whole into the revisions table
// and no door reads it back.
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
  // Inside the catch: an instant this session cannot end at is a 400, never a 500.
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
    // The wire bounds an instant on its own; only the stored row knows this one runs backwards.
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
  // The cursor is the previous page's LAST ROW, both halves — `before` its startedAt and `beforeId`
  // its id — because only the pair is unique. An id with no instant is a bad cursor, not a
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
  // WEAK: it certifies the facts a poll acts on rather than byte equality of a body this handler
  // never compared. Three terms — the session's own two instants, and a fold over the sets as this
  // reply renders them. startedAt leads, so a session discarded and recreated under the same id is
  // never a 304 echo of the dead workout. Only the two success paths carry the tag.
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

// Computed from the stored rows on every call and kept nowhere.
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

// The prefill: what this account did the last time it trained this movement.
//
//   { "exerciseId": "bench-press",
//     "session": { "id", "startedAt", "finishedAt", … },   omitted when there is no last time
//     "routine": "Bench day",                              omitted when that session was ad-hoc
//     "sets":    [ … ] }                                   omitted with the session; never empty
//
// The movement is echoed back so a reply arriving after the lifter has moved on is discardable. A
// first-ever movement is answered 200 with the movement and nothing else.
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

// The picker's meta in ONE read: what this lifter last did of each movement they have trained, and
// when. A movement absent here is the picker's `never logged`.
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

// Every set this account holds: one shape, no parameters, no pagination, nothing omitted.
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

// Owner-scoped, and idempotent on the SESSION rather than on a client-minted id. An expired share
// is replaced, so the reply always carries the instant the link it handed over ends at.
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
  // The link is the server's to compose, not each client's.
  Json::Value body(Json::objectValue);
  body["token"] = share->token;
  body["url"] = shareUrl(appBaseUrl_, share->token);
  body["expiresAt"] = Json::Value::UInt64(share->expiresAtMs);
  cb(jsonResponse(body));
}

// Revoked is deleted: the row IS the capability. Nothing to revoke is the same 404 an absent
// session gets.
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

// Resolves no caller: the token in the path is the whole credential. It touches auth not at all and
// never writes. Revoked, expired and never-minted answer this ONE 404, byte for byte. The body names
// no account and holds no id at any depth.
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
