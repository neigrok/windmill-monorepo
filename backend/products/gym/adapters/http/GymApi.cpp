#include "products/gym/adapters/http/GymApi.h"

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

// FNV-1a, 64-bit, over the bytes the session read is about to write. It is what makes a session's
// ETag cover a CORRECTION: a fix moves neither the set count nor the last instant nor finished_at,
// so a tag built from those alone answered 304 with a stale weight on the mirror's screen. Folding
// the rendered sets instead is exact by construction — anything a poll could act on is in those
// bytes, and nothing else is.
std::uint64_t fold(const std::string& text) {
  std::uint64_t hash = 14695981039346656037ull;
  for (const unsigned char byte : text) {
    hash ^= byte;
    hash *= 1099511628211ull;
  }
  return hash;
}

// If-None-Match read per RFC 9110 §13.1.2: the field is a comma-separated list of entity-tags —
// each optionally W/-prefixed — or the lone "*", and the comparison is the WEAK one: strip W/ from
// both sides and compare the quoted opaque-tags byte for byte. "*" matches any current
// representation, which the caller only asks about after finding one.
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

GymApi::GymApi(std::shared_ptr<LogService> log, std::shared_ptr<AuthService> auth,
               std::string appBaseUrl)
    : log_(std::move(log)), auth_(std::move(auth)), appBaseUrl_(std::move(appBaseUrl)) {}

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

// The picker's meta, in ONE read: what this lifter last did of each movement they have trained, and
// when. It is a second read rather than four more columns on the catalog row, and the reason is
// arithmetic: the catalog is 64 rows read on nearly every screen, most of them movements a given
// lifter has never touched, and `list_exercises` hands that same row to an agent whose reply a whole
// token-budget wave was spent shrinking. So the annotation is asked for by the one surface that
// draws it, and it carries a line only for the movements that have one — a movement absent here is
// the picker's `never logged`, said by saying nothing.
//
// It is also not sixty-four calls to `/v1/gym/last`, one per catalog row, which is the shape a
// picker would otherwise reach for: the N+1 the log read already refused when it made a summary
// carry its own derived facts. Sixty-four is the seeded catalog counted (db/schema.sql), plus
// whatever this account has created — the design mock says 62 in its search placeholder and the
// mock is the one that is wrong.
void GymApi::lastSets(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["movements"] = toJson(log_->lastSets(*caller));
  cb(jsonResponse(body));
}

// The movement a lifter creates from the picker, off "no movement by that name". It is theirs
// alone — created_by is the owner, and the catalog read only ever serves the seeds plus the
// caller's own — so the reply is the row every later set and routine entry points at by id.
void GymApi::createExercise(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
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
  ExerciseInsertOutcome outcome{std::nullopt, ExerciseInsertError::none};
  try {
    outcome = log_->createExercise(*caller, parseExerciseWrite(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that movement"));
    return;
  }
  if (outcome.error == ExerciseInsertError::idTaken) {
    // A seed's slug or another lifter's custom id, told apart by nobody: mint a new id and send it
    // again. The caller's OWN id is not this refusal — it replays, answering with the movement
    // already stored under it, because the alternative is what §2.1 exists to prevent: a lost reply
    // re-minted into a second "Zercher Squat" that every later set then forks history across.
    cb(error(drogon::k409Conflict, "that movement id is taken", "exercise-id-taken"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.exercise)));
}

// The rename, and the whole point of stable exercise identity made visible: the movement keeps its
// id, so every set, every routine entry and every frozen plan snapshot still names it and the
// history stays whole. What the store does under this depends on whose row it is — a movement the
// caller created renames in place, a SEED takes a per-account display name, because the 64 seeds
// are global rows and renaming one in place would rename it for every lifter on the server.
void GymApi::renameExercise(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
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
  std::optional<Exercise> renamed;
  try {
    renamed = log_->renameExercise(*caller, ExerciseId{id}, parseExerciseRename(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that name"));
    return;
  }
  if (!renamed) {
    // The path names a movement this account's catalog does not hold. Absent and another lifter's
    // private movement are the one fact, exactly as an absent session is.
    cb(error(drogon::k404NotFound, "no such movement"));
    return;
  }
  cb(jsonResponse(toJson(*renamed)));
}

// A movement's record: one exercise, one page, and one read behind it — the two tiles, the twelve
// weeks of bars, the record ladder and the recent days all come off a single call, because a page
// that made a request per tile is a page that draws in four stages. Every number in it is computed
// from stored rows on this call and kept nowhere, the rule every read surface in this product
// obeys. A movement in the catalog nobody has lifted answers 200 with its counts at zero and no
// lists at all — that is a fact, not a fault, and it is what the picker's `never logged` is drawn
// from; the 404 below is the different sentence "no such movement".
void GymApi::exerciseRecord(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                            const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<MovementRecord> record = log_->movementRecord(*caller, ExerciseId{id});
  if (!record) {
    cb(error(drogon::k404NotFound, "no such movement"));
    return;
  }
  cb(jsonResponse(toJson(*record)));
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
  if (outcome.error == StartError::unknownRoutine) {
    // The same one fact every absent thing gets: this account cannot read that routine, and whether
    // it never existed or belongs to someone else is not said. Starting ad-hoc instead would be the
    // real failure — a workout with no targets that nothing on screen could tell apart from a plan.
    cb(error(drogon::k404NotFound, "no such routine"));
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
  if (outcome.error == AppendError::deleted) {
    // The id names a set this lifter DELETED, and this append is a replay of the POST that logged
    // it — from a queue whose 200 was lost, or from a claim replaying the device's own log. The set
    // is not owed and it is not coming back: drop it. It is deliberately NOT `set-id-taken`, whose
    // documented repair on all three surfaces is "mint a fresh id and send the set again" — the one
    // move that would put a deleted set back in the log under a new number. Every queue's default
    // for a 409 it does not know is terminal, so this word is safe to speak at a client built before
    // it existed: the pending set is dropped either way, and the sentence is what gets said.
    cb(error(drogon::k409Conflict, "that set was deleted", "set-deleted"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.set)));
}

// §G18's `Save the fix`: the one write in gym that changes a row a lifter already made. PATCH and
// not PUT because a fix names the number that was wrong and nothing else — a PUT would promise the
// whole set, and three of a set's fields are not a lifter's to rewrite (adapters/json/TrainingJson.h
// lists them and says why). It answers the STORED row, so a retry whose reply was lost reads back
// the same values rather than compounding a change, and both refusals carry a word a queue can
// branch on.
//
// What it never touches is the caption of the whole screen: the session's frozen plan and the
// routine it was copied from. *Push A keeps its own numbers.* The log moves; the program does not.
void GymApi::fixSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id,
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
    fixed = log_->fixSet(*caller, SessionId{id}, SetId{setId}, parseSetFix(*json));
  } catch (const InvalidTraining&) {
    // One word for every way a correction can be unreadable — a field a fix may not carry, a value
    // outside the band the store keeps, a kind nobody logs — because they share one repair: the
    // client is wrong and no retry of these bytes helps. A storage failure is NOT this, and rides
    // past the catch to the house 500, which is the status a queue retries.
    cb(error(drogon::k400BadRequest, "could not read that fix", "fix-unreadable"));
    return;
  }
  if (!fixed) {
    // The set is gone, was never this account's, or belongs to a different workout — one answer for
    // all three, byte for byte, so a set id cannot be probed for existence. It is terminal for a
    // queue: nothing about these bytes will land, and the pending edit is dropped.
    cb(error(drogon::k404NotFound, "no such set", "set-not-found"));
    return;
  }
  cb(jsonResponse(toJson(*fixed)));
}

// `Delete set`, and it refuses NOTHING — a set that was never here does not stand either, so a
// client whose reply was lost sends the same request again and gets the same 204. That is the whole
// reason the idempotency is spelled this way rather than as a 404: the queue behind this route
// retries, and a delete that answered "no such set" on the second try would teach it to treat its
// own successful writes as failures.
//
// Nothing on screen may promise this back. The row moves whole into the revisions table so nothing
// a lifter logged is destroyed, and there is no door that reads it — no trash, no recovery, no
// thirty days. What the copy says is what is true: the set leaves the log.
void GymApi::deleteSet(const drogon::HttpRequestPtr& req, HttpCallback&& cb, const std::string& id,
                       const std::string& setId) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  log_->deleteSet(*caller, SessionId{id}, SetId{setId});
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
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
  for (const LogRow& row : log_->log(*caller, cursor)) sessions.append(toJson(row));
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
  // The mirror's freshness tag (§11.3): WEAK, because it certifies the facts a poll acts on rather
  // than byte equality of a body this handler never compared. Three terms, none of them subsuming
  // another — the session's own two instants, and a fold over the sets as this reply renders them.
  //
  // The fold replaced (set count, last completedAt) in W3, and it had to: a set is no longer
  // insert-only, so a correction can change what a lifter reads while leaving all three of the old
  // terms exactly where they were, and the mirror would have polled a 304 forever over a weight that
  // had moved. startedAt still leads, so a session discarded and recreated under the same id is a
  // new representation and never a 304 echo of the dead workout. Only the two success paths carry
  // the tag — the 401 and the 404 above stay byte-identical to what they always answered.
  const Json::Value sets = toJson(detail->sets);
  const std::string tag = "W/\"" + std::to_string(detail->session.startedAtMs) + "-" +
                          std::to_string(detail->session.finishedAtMs.value_or(0)) + "-" +
                          std::to_string(fold(dump(sets))) + "\"";
  if (ifNoneMatchAccepts(req->getHeader("if-none-match"), tag)) {
    auto unchanged = drogon::HttpResponse::newHttpResponse();
    unchanged->setStatusCode(drogon::k304NotModified);
    // CT_NONE maps to the empty mime string, which drogon renders as no content-type line at all;
    // the `content-length: 0` it still writes on a 304 is accepted noise — suppressing it means
    // setPassThrough, which drops connection handling with it.
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

// The finish screen, and the same readout the session detail draws. It is a pure read — computed
// from the stored rows on every call and kept nowhere — so a set that arrives late from a flush
// queue is counted the next time it is asked for, and a session absent or another account's is the
// one fact every read here gives.
void GymApi::reviewSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                           const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<Review> review = log_->review(*caller, SessionId{id});
  if (!review) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  cb(jsonResponse(toJson(*review)));
}

// The one destructive action in the product. It takes the session and its sets together and answers
// with nothing, because there is nothing left to describe.
void GymApi::discardSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                            const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  DiscardOutcome outcome = log_->discard(*caller, SessionId{id});
  if (outcome == DiscardOutcome::notFound) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  if (outcome == DiscardOutcome::open) {
    // Its own code, because its repair is unlike every other 409's: nothing the client re-mints or
    // re-sends helps. Only the device holding the offline queue knows every set has landed, so the
    // workout is finished (or the four-hour auto-close fires) and the discard is sent again. The
    // product offers it at the finish screen, after the close, where this is unreachable.
    cb(error(drogon::k409Conflict, "that session is still running", "session-open"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
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

// The plan, over four handlers that share one shape. A routine is written as its WHOLE document —
// create and replace send the same body, and the editor's every change is a read-modify-write of it
// — so nothing here edits a line, reorders one, or reconciles a partial update against a store that
// moved underneath it.
void GymApi::listRoutines(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  Json::Value body(Json::objectValue);
  // The dot §B5 draws beside a day of the program rides on the list rather than on a second call
  // per routine — the same N+1 the log read refused when it made its summary carry its own facts.
  body["routines"] = toJson(log_->routines(*caller),
                            log_->proposals(*caller, ProposalQuery{std::nullopt, true}));
  cb(jsonResponse(body));
}

void GymApi::createRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
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
  RoutineWriteOutcome outcome{std::nullopt, RoutineWriteError::none};
  try {
    // No door: this route is a lifter's own hand on their own phone, which is the whole of §M's
    // third door and what the routine's history says by saying nothing about who made it.
    outcome = log_->createRoutine(*caller, parseRoutineWrite(*json), std::nullopt);
  } catch (const InvalidTraining&) {
    // One sentence for every way a routine can be unstorable as written: no entries, a name that is
    // empty or over eighty characters, a position out of range, an entry outside its bounds.
    cb(error(drogon::k400BadRequest, "could not read that routine"));
    return;
  }
  if (outcome.error == RoutineWriteError::idTaken) {
    // Spent by an account this caller cannot see, so it is a fact about an id and never about an
    // owner. Its own replay is not this refusal — it answers with the routine already stored.
    cb(error(drogon::k409Conflict, "that routine id is taken", "routine-id-taken"));
    return;
  }
  if (outcome.error == RoutineWriteError::unknownExercise) {
    // The same fact a set naming no known movement gets, under the same machine word: the entry has
    // to be resolved against GET /v1/gym/exercises before the plan can hold it.
    cb(error(drogon::k400BadRequest, "no such exercise", "unknown-exercise"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.routine)));
}

void GymApi::getRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                        const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<Routine> routine = log_->routine(*caller, RoutineId{id});
  if (!routine) {
    cb(error(drogon::k404NotFound, "no such routine"));
    return;
  }
  // Newest first, so the first is the one a card draws when two doors each have one waiting. It is
  // its OWN read and not the pending row of the history below, however alike the two look: the
  // history is a bounded window of the newest rows, and a proposal from a quiet door can be older
  // than that window while still waiting. A dot that vanished once a day had twenty newer settled
  // proposals would be the product hiding a decision the lifter still has to make.
  std::optional<ProposalHead> pending;
  for (const ProposalHead& head : log_->proposals(*caller, ProposalQuery{RoutineId{id}, true}))
    if (!pending) pending = head;
  // The History section (§M30) rides on this read and not on a route of its own, because it is one
  // section of the screen this read already draws — and a screen that fetched its history separately
  // would draw the day, then the day's past, in two frames. The LIST read carries none of it: a
  // routines screen prints names.
  Json::Value body = toJson(*routine, pending);
  body["history"] = toJson(log_->routineHistory(*caller, RoutineId{id}));
  cb(jsonResponse(body));
}

void GymApi::replaceRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
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
  // The PATH names the routine being replaced — a read-modify-write sends back the id it read, so
  // the two always agree, and where they could not the URL is what the store was asked for.
  RoutineWriteOutcome outcome{std::nullopt, RoutineWriteError::none};
  try {
    outcome = log_->replaceRoutine(*caller, RoutineId{id}, parseRoutineWrite(*json));
  } catch (const InvalidTraining&) {
    cb(error(drogon::k400BadRequest, "could not read that routine"));
    return;
  }
  if (outcome.error == RoutineWriteError::notFound) {
    cb(error(drogon::k404NotFound, "no such routine"));
    return;
  }
  if (outcome.error == RoutineWriteError::unknownExercise) {
    cb(error(drogon::k400BadRequest, "no such exercise", "unknown-exercise"));
    return;
  }
  cb(jsonResponse(toJson(*outcome.routine)));
}

void GymApi::deleteRoutine(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                           const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  if (!log_->deleteRoutine(*caller, RoutineId{id})) {
    cb(error(drogon::k404NotFound, "no such routine"));
    return;
  }
  // Nothing to say and no body to say it in. Every session ever trained under this routine keeps its
  // frozen snapshot, so deleting the plan never edits what the log says about the past.
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

// THE PROPOSAL LEDGER, over four handlers, and the last two are the tap §D14 draws. They are HTTP
// and nothing else on purpose: the tool layer is the only place gym can tell an agent from a hand,
// and Apply is the one act this whole design exists to keep in the hand. No MCP tool reaches these
// at any grant level, and `GymToolsTest` pins the absence by name so no wave can "complete the
// catalog" here without deleting §D from the product.
//
// One list read serves the three questions the surfaces ask — every pending proposal on the account
// (Today's card), one routine's whole run including its settled history (the routine editor's
// History section), and one routine's pending (the dot). A settled proposal stays in that list
// forever, because an agent's suggestion is part of the program's history rather than a toast that
// disappears.
void GymApi::listProposals(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  ProposalQuery query;
  const std::string routine = req->getParameter("routineId");
  if (!routine.empty()) query.routine = RoutineId{routine};
  query.pendingOnly = req->getParameter("state") == "pending";
  Json::Value body(Json::objectValue);
  body["proposals"] = toJson(log_->proposals(*caller, query));
  cb(jsonResponse(body));
}

// The diff screen's whole read, and the one a deep link from an agent's receipt lands on. Absent,
// another account's and never-existed are the one answer, exactly as every other read here.
void GymApi::getProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                         const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<RoutineProposal> held = log_->proposal(*caller, ProposalId{id});
  if (!held) {
    cb(error(drogon::k404NotFound, "no such proposal"));
    return;
  }
  cb(jsonResponse(toJson(*held)));
}

// The tap. All of it or none — the domain computes the routine the proposal makes true and the
// store writes it in one transaction against the frozen base revision — so there is no half-applied
// state for a client to reconcile and no partial reply to draw.
//
// The answer carries BOTH: the settled proposal (so the card can redraw as `Applied` with its
// timestamp and stay) and the routine as it now stands (so the editor behind it redraws without a
// second read). The routine is absent for a removal, because there is no longer one.
void GymApi::applyProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                           const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  ProposalSettleOutcome outcome{std::nullopt, std::nullopt, ProposalSettleError::none};
  try {
    outcome = log_->apply(*caller, ProposalId{id});
  } catch (const InvalidTraining&) {
    // Unreachable through the mint, which builds the document through the Routine constructor
    // before anything is stored — and kept because the alternative is a 500 on the one tap this
    // product cannot afford to fail opaquely.
    cb(error(drogon::k400BadRequest, "could not apply that proposal"));
    return;
  }
  if (outcome.error == ProposalSettleError::notFound) {
    cb(error(drogon::k404NotFound, "no such proposal"));
    return;
  }
  if (outcome.error == ProposalSettleError::superseded) {
    cb(error(drogon::k409Conflict,
             "that routine changed after this proposal was written, so it was not applied",
             "proposal-superseded"));
    return;
  }
  if (outcome.error == ProposalSettleError::settled) {
    cb(error(drogon::k409Conflict, "that proposal was already dismissed", "proposal-settled"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["proposal"] = toJson(*outcome.proposal);
  if (outcome.routine) body["routine"] = toJson(*outcome.routine);
  cb(jsonResponse(body));
}

// No reason is asked for and nothing changes. It stays in the routine's history in case the lifter
// wants it back, which is why this is a settle rather than a delete.
void GymApi::dismissProposal(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                             const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  const ProposalSettleOutcome outcome = log_->dismiss(*caller, ProposalId{id});
  if (outcome.error == ProposalSettleError::notFound) {
    cb(error(drogon::k404NotFound, "no such proposal"));
    return;
  }
  if (outcome.error == ProposalSettleError::superseded) {
    cb(error(drogon::k409Conflict,
             "that routine changed after this proposal was written, so there is nothing left to "
             "dismiss",
             "proposal-superseded"));
    return;
  }
  if (outcome.error == ProposalSettleError::settled) {
    cb(error(drogon::k409Conflict, "that proposal was already applied", "proposal-settled"));
    return;
  }
  Json::Value body(Json::objectValue);
  body["proposal"] = toJson(*outcome.proposal);
  cb(jsonResponse(body));
}

// The statistics ENGINE, over values the domain already decides: a per-movement line of top working
// sets with Epley on top, the two standing bests, when each movement was last trained, and the
// weekly counts. It takes no parameters at all — no window, no movement filter, no page — because
// the whole point of it is the long view, and every number in it is a fact with a direction rather
// than a grade.
//
// No app screen reads this route: W1c retired the statistics room on all three surfaces and put a
// movement's record (`GET /v1/gym/exercises/{id}/record`) where a lifter goes instead. It stays for
// the reader it was always best for — an agent through `get_stats`, asking how a lift has moved
// (domain/Statistics.h). Unreached by a tab is not unreachable.
// §I's rows, read. It is the one read in gym that cannot 404: a lifter who has never opened this
// screen holds no row and is answered with the DEFAULTS, because every client needs the rest target
// and the reading unit before it can draw a first frame. Nothing is written on the way out.
void GymApi::preferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(toJson(log_->preferences(*caller))));
}

// And written — the WHOLE document, the shape a routine travels in, because the screen renders all
// every row from one value it already holds. A field the body does not name takes its default;
// there is no partial write, so nothing here has to reconcile one against a store that moved.
//
// UNITS REACH NOTHING. `lb` is stored as the lifter's reading unit and changes no column, no wire
// number and no rule in this product: kilograms are what a set weighs here and always were, and
// this route is the only place in gym that has ever heard of another unit.
void GymApi::savePreferences(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::shared_ptr<Json::Value> json = req->getJsonObject();
  if (!json) {
    cb(error(drogon::k400BadRequest, "expected json", "preferences-unreadable"));
    return;
  }
  // The codec builds the entity, so every refusal below is a value the store could not have held —
  // and each carries the machine word that says which row to send the lifter back to.
  // The wider catch is the owner's, which no signed-in caller can trip; it keeps a domain refusal
  // from riding out as the house 500 the phones' queues are told to retry forever.
  try {
    cb(jsonResponse(toJson(log_->savePreferences(parsePreferences(*json, *caller)))));
  } catch (const InvalidPreference& refused) {
    cb(error(drogon::k400BadRequest, refused.what(), refused.code.c_str()));
  } catch (const InvalidTraining& malformed) {
    cb(error(drogon::k400BadRequest, malformed.what(), "preferences-unreadable"));
  }
}

void GymApi::stats(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(toJson(log_->statistics(*caller))));
}

// Every set this account holds, as the file a lifter walks away with. It is the trust argument for
// a multi-year artifact and so it is deliberately dull: one shape, no parameters, no pagination,
// nothing omitted. The filename is fixed rather than stamped with a date — a re-export is the same
// file with more rows in it, and a browser that numbers the duplicates says something true.
void GymApi::exportSets(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k200OK);
  response->setContentTypeCode(drogon::CT_TEXT_CSV);
  response->addHeader("Content-Disposition", "attachment; filename=\"windmill-gym-sets.csv\"");
  response->setBody(toCsv(log_->exportedSets(*caller)));
  cb(response);
}

// Every conversation this account has had, as the file it walks away with — the same deliberately
// dull export the sets get: no parameters, no pagination, nothing omitted, and the turns byte for
// byte. It is a SECOND file rather than more columns on the first because a CSV row is one shape,
// and a set and a sentence are not one shape.
//
// It stays mounted on a deployment with no vendor key, where `POST /v1/gym/ask` does not exist:
// what a lifter said is theirs whether or not there is a model on our side to say it to.
void GymApi::exportThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k200OK);
  response->setContentTypeCode(drogon::CT_TEXT_CSV);
  response->addHeader("Content-Disposition", "attachment; filename=\"windmill-gym-threads.csv\"");
  response->setBody(toCsv(log_->exportedThreadTurns(*caller)));
  cb(response);
}

// ── Ask's threads (§O) ─────────────────────────────────────────────────────────────────────────
//
// THE LIST IS NOT AN INBOX, and nothing here makes one: no unread count, no badge, no state a
// client could draw as something waiting. Every row is a title the lifter typed and an outcome the
// server observed, and the reply carries nothing else — because there is nothing else that would be
// true.
void GymApi::listThreads(const drogon::HttpRequestPtr& req, HttpCallback&& cb) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  cb(jsonResponse(toJson(log_->threads(*caller))));
}

void GymApi::getThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                       const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<AskThread> held = log_->thread(*caller, ThreadId{id});
  if (!held) {
    // Absent and another account's, told apart by nobody — the one answer every owner-scoped read in
    // this product gives.
    cb(error(drogon::k404NotFound, "no such conversation"));
    return;
  }
  cb(jsonResponse(toJson(*held)));
}

// DELETE DELETES THE CONVERSATION, NOT THE CONSEQUENCE (§O). The turns go with the row; the
// proposals it minted do not — an applied change stays in the routine's history, still saying it came
// from Ask, and simply no longer opens a conversation that exists. That is not a leniency about
// deletion: an applied change is a fact about somebody's program rather than a message, and deleting
// the message must not rewrite what their program did.
void GymApi::deleteThread(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                          const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  if (!log_->deleteThread(*caller, ThreadId{id})) {
    cb(error(drogon::k404NotFound, "no such conversation"));
    return;
  }
  // Nothing to say and no body to say it in — and the routine's history behind it is untouched.
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

// The coach share, minted. Owner-scoped like every other write — an absent session and another
// account's are the one fact this whole product gives — and idempotent on the SESSION rather than
// on a client-minted id, because there is no id for a client to mint here: tapping Share twice
// answers with the link already live, so a lifter never sends two capabilities they would then have
// to revoke separately. A share that has already expired is replaced instead, which is why the
// reply always carries the instant the link it just handed over actually ends at.
void GymApi::shareSession(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                          const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  std::optional<SessionShare> share = log_->share(*caller, SessionId{id});
  if (!share) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  // The link is the server's to compose, not each client's: the token alone is not something a
  // lifter can hand anybody, and when three surfaces built it themselves two of them built the JSON
  // route and showed a coach a page of JSON.
  Json::Value body(Json::objectValue);
  body["token"] = share->token;
  body["url"] = shareUrl(appBaseUrl_, share->token);
  body["expiresAt"] = Json::Value::UInt64(share->expiresAtMs);
  cb(jsonResponse(body));
}

// Revoked is deleted: the row IS the capability, so there is nothing to mark and nothing left to
// describe. Nothing to revoke is the same 404 an absent session gets, for the same reason — a
// caller learns about their own log and never about anyone else's.
void GymApi::revokeShare(const drogon::HttpRequestPtr& req, HttpCallback&& cb,
                         const std::string& id) {
  std::optional<UserId> caller = callerOf(req, *auth_);
  if (!caller) {
    cb(error(drogon::k401Unauthorized, "sign in to open your training log"));
    return;
  }
  if (!log_->revokeShare(*caller, SessionId{id})) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k204NoContent);
  cb(response);
}

// The one route in gym that resolves no caller, and the token in the path is the whole credential.
// It never touches auth at all — a coach has no account here and must not be told to make one —
// and it never writes, not even the four-hour close every signed-in read of the log takes: a
// stranger holding a link cannot be allowed to change the owner's log by reading it.
//
// Revoked, expired and never-minted answer this ONE 404, byte for byte, which is what stops a token
// from being probed for existence. The body it hands back names no account and holds no id at any
// depth — it is one workout, and nothing that could be walked to a second one.
void GymApi::sharedSession(const drogon::HttpRequestPtr&, HttpCallback&& cb,
                           const std::string& token) {
  std::optional<SharedSession> shared = log_->shared(token);
  if (!shared) {
    cb(error(drogon::k404NotFound, "no such session"));
    return;
  }
  cb(jsonResponse(toJson(*shared)));
}

}
