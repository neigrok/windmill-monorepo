#include "products/gym/adapters/http/TrainingApi.h"

#include "platform/adapters/http/Caller.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/json/JsonText.h"
#include "products/gym/adapters/json/GymJson.h"

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

TrainingApi::TrainingApi(std::shared_ptr<TrainingService> training, std::shared_ptr<GymWriteDoor> door,
                         std::shared_ptr<AuthService> auth, std::string appBaseUrl)
    : training_(std::move(training)), door_(std::move(door)), appBaseUrl_(std::move(appBaseUrl)),
      auth_(std::move(auth)) {}

// A past workout written whole: it lands with every set or not at all, and answers in the shape
// `GET /v1/gym/sessions/{id}` does — 201 when it landed now, 200 when this exact import landed
// before. A refusal naming one set says which as `sets[i] (id)`.
void TrainingApi::importSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb) try {
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
  std::optional<SessionImport> incoming;
  BatchLogOutcome outcome;
  try {
    incoming = parseSessionImport(*json);
    outcome = door_->importSession(*caller, *incoming);
  } catch (const InvalidTraining& refused) {
    cb(error(drogon::k400BadRequest, refused.what()));
    return;
  }
  const std::string where = outcome.errorIndex
      ? "sets[" + std::to_string(*outcome.errorIndex) + "] (" +
            incoming->sets[*outcome.errorIndex].id.str() + "): "
      : "";
  switch (outcome.error) {
    case BatchLogError::none: break;
    case BatchLogError::overlap: {
      // The crossed session travels whole, so the refusal can name it and link to it.
      Json::Value body(Json::objectValue);
      body["error"] = "these times cross a session already in the log";
      body["code"] = "session-overlap";
      body["sessionId"] = outcome.overlapping->id.str();
      body["session"] = toJson(*outcome.overlapping);
      cb(jsonResponse(body, drogon::k409Conflict));
      return;
    }
    case BatchLogError::idTaken:
    case BatchLogError::payloadConflict:
      // Spent by another account, or by this one with a different workout: whose is never said.
      if (outcome.errorIndex)
        cb(error(drogon::k409Conflict, where + "that set id is already used", "set-id-taken"));
      else
        cb(error(drogon::k409Conflict, "that session id is taken", "session-id-taken"));
      return;
    case BatchLogError::unknownExercise:
      cb(error(drogon::k400BadRequest, where + "no such exercise", "unknown-exercise"));
      return;
    case BatchLogError::unknownRoutine:
      // Never-existed and someone else's are one answer.
      cb(error(drogon::k404NotFound, "no such routine"));
      return;
    case BatchLogError::notFound:
    case BatchLogError::finished:
    case BatchLogError::deleted:
      // An append's refusals. An import creates its session, and a deleted set's id is still held by
      // its receipt, which answers set-id-taken first.
      cb(error(drogon::k500InternalServerError, "that import failed inside the server"));
      return;
  }
  // The row as it stands now, read the way the session's own route reads it. A replay of an import
  // since discarded finds nothing, and is not brought back.
  const std::optional<SessionDetail> stored =
      outcome.sessionDeleted ? std::nullopt : training_->detail(*caller, incoming->id);
  if (!stored) {
    cb(error(drogon::k409Conflict, "that workout was discarded", "session-deleted"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["session"] = toJson(stored->session);
  body["sets"] = toJson(stored->sets);
  cb(jsonResponse(body, outcome.replayed ? drogon::k200OK : drogon::k201Created));
} catch (const GymUnavailable& unavailable) {
  cb(error(drogon::k503ServiceUnavailable, unavailable.what(), unavailable.code.c_str()));
}

void TrainingApi::listSessions(const drogon::HttpRequestPtr& req, HttpCallback&& cb) try {
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
} catch (const GymUnavailable& unavailable) {
  cb(error(drogon::k503ServiceUnavailable, unavailable.what(), unavailable.code.c_str()));
}

void TrainingApi::getSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                        const std::string& id) try {
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
  Json::Value body(Json::objectValue);
  body["session"] = toJson(detail->session);
  body["sets"] = toJson(detail->sets);
  const std::string tag = "W/\"" + std::to_string(detail->session.startedAtMs) + "-" +
      std::to_string(detail->session.finishedAtMs.value_or(0)) + "-" +
      std::to_string(fold(dump(body))) + "\"";
  if (ifNoneMatchAccepts(req->getHeader("if-none-match"), tag)) {
    auto unchanged = drogon::HttpResponse::newHttpResponse();
    unchanged->setStatusCode(drogon::k304NotModified);
    // CT_NONE maps to the empty mime string, which drogon renders as no content-type line at all.
    unchanged->setContentTypeCode(drogon::CT_NONE);
    unchanged->addHeader("ETag", tag);
    cb(unchanged);
    return;
  }
  drogon::HttpResponsePtr response = jsonResponse(body);
  response->addHeader("ETag", tag);
  cb(response);
} catch (const GymUnavailable& unavailable) {
  cb(error(drogon::k503ServiceUnavailable, unavailable.what(), unavailable.code.c_str()));
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

void TrainingApi::stats(const drogon::HttpRequestPtr& req, HttpCallback&& cb) try {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  if (req->getParameter("projection") == "progress") {
    cb(jsonResponse(toJson(training_->progress(*caller))));
    return;
  }
  cb(jsonResponse(toJson(training_->statistics(*caller))));
} catch (const GymUnavailable& unavailable) {
  cb(error(drogon::k503ServiceUnavailable, unavailable.what(), unavailable.code.c_str()));
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
