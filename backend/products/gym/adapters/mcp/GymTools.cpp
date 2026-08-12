#include "products/gym/adapters/mcp/GymTools.h"

#include "products/gym/adapters/json/TrainingJson.h"
#include "products/gym/adapters/mcp/GymToolCatalog.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <new>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wm::gym {

namespace {

// The four refusals that are about a THING rather than an argument, and each of them is the same
// fact the HTTP edge gives — absent, another account's and never-existed are one answer, so a
// caller learns about their own log and never about anyone else's. What is added for an agent is the
// second half: the tool that would have answered the question, because a model cannot read a doc
// between two calls the way a person can. The tool name is stamped onto every one of these exactly
// once, by callTool, so no sentence here repeats it.
constexpr char kNoSession[] = "no workout of yours has that id. Call list_sessions for the ids you own.";
constexpr char kNoRoutine[] = "no routine of yours has that id. Call list_routines for the ids you own.";
constexpr char kNoExercise[] = "no movement has that id. Call list_exercises for the catalog, or "
                               "create_exercise to add one.";
constexpr char kNoShare[] = "there is no live coach link on that workout, so there is nothing to "
                            "revoke — revoked, expired and never-minted are one answer here.";

// What a value IS, for the one refusal that can only quote the shape back: a tool called with a
// bare string or an array where its named arguments belong.
std::string typeName(const Json::Value& value) {
  if (value.isNull()) return "null";
  if (value.isBool()) return "a boolean";
  if (value.isArray()) return "an array";
  if (value.isString()) return "a string";
  if (value.isNumeric()) return "a number";
  return "that";
}

// One required id argument, read under its published spelling. It answers the whole refusal when the
// argument is missing or is not a non-empty string, and fills `out` when it is fine — so every tool
// below reads as a fail-fast pipeline, top to bottom. `discover` is the tool that lists the ids,
// which is the move a caller that got here has to make next.
std::optional<std::string> idArgument(const Json::Value& args, const char* field, const char* discover,
                                      std::string& out) {
  const Json::Value& value = args[field];
  if (value.isString() && !value.asString().empty()) {
    out = value.asString();
    return std::nullopt;
  }
  if (value.isNull())
    return "missing required argument \"" + std::string(field) + "\". " + discover;
  return "\"" + std::string(field) + "\" must be a non-empty id string. " + discover;
}

// --- The reads -------------------------------------------------------------------------------

ToolResult listExercises(LogService& log, const UserId& caller) {
  Json::Value out(Json::objectValue);
  out["exercises"] = toJson(log.catalog(caller));
  return ToolResult::json(out);
}

ToolResult listSessions(LogService& log, const UserId& caller, const Json::Value& args) {
  // The cursor is the previous page's LAST ROW, both halves of it, because only the pair is unique:
  // a bare instant cursor drops a workout whose start ties with another's across a page edge, and it
  // is then in no page, ever. No cursor at all means "from now".
  LogCursor cursor{kMaxInstantMs, std::nullopt, kDefaultLogLimit};
  if (!args["before"].isNull()) {
    if (!args["before"].isUInt64() || args["before"].asUInt64() == 0 ||
        args["before"].asUInt64() > kMaxInstantMs)
      return ToolResult::failure("\"before\" must be the previous page's last workout `startedAt`, "
                                 "as epoch milliseconds.");
    cursor.beforeMs = args["before"].asUInt64();
  }
  if (!args["beforeId"].isNull()) {
    std::string beforeId;
    if (std::optional<std::string> bad = idArgument(
            args, "beforeId", "It is the previous page's last workout id.", beforeId))
      return ToolResult::failure(*bad);
    if (args["before"].isNull())
      return ToolResult::failure("\"beforeId\" needs \"before\" beside it — an id with no instant "
                                 "names no row in the page order.");
    cursor.beforeId = SessionId{beforeId};
  }
  if (!args["limit"].isNull()) {
    if (!args["limit"].isInt() || args["limit"].asInt() < 1)
      return ToolResult::failure("\"limit\" must be a whole number of workouts, 1 to " +
                                 std::to_string(kMaxLogLimit) + ".");
    cursor.limit = std::min(args["limit"].asInt(), kMaxLogLimit);
  }

  Json::Value sessions(Json::arrayValue);
  for (const LogRow& row : log.log(caller, cursor)) sessions.append(toJson(row));
  Json::Value out(Json::objectValue);
  out["sessions"] = sessions;
  return ToolResult::json(out);
}

// One workout with its sets, and — asked for — the finish readout over the same rows. The two ride
// on one tool because they are one question about one workout, and a second tool for the second half
// would cost every connection a slot in tools/list to save this one an argument.
ToolResult getSession(LogService& log, const UserId& caller, const Json::Value& args) {
  std::string id;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions for the ids you own.", id))
    return ToolResult::failure(*bad);
  if (!args["review"].isNull() && !args["review"].isBool())
    return ToolResult::failure("\"review\" must be true or false.");

  std::optional<SessionDetail> detail = log.detail(caller, SessionId{id});
  if (!detail) return ToolResult::failure(kNoSession);
  Json::Value out(Json::objectValue);
  out["session"] = toJson(detail->session);
  out["sets"] = toJson(detail->sets);
  if (args["review"].isBool() && args["review"].asBool())
    if (std::optional<Review> readout = log.review(caller, SessionId{id}))
      out["review"] = toJson(*readout);
  return ToolResult::json(out);
}

ToolResult lastTime(LogService& log, const UserId& caller, const Json::Value& args) {
  std::string id;
  if (std::optional<std::string> bad =
          idArgument(args, "exerciseId", "Call list_exercises for the catalog.", id))
    return ToolResult::failure(*bad);

  LastTimeOutcome outcome = log.lastTime(caller, ExerciseId{id});
  if (outcome.error == LastTimeError::unknownExercise) return ToolResult::failure(kNoExercise);
  // A first-ever movement answers with the movement and nothing else. That absence is the whole
  // answer — "you have never trained this" — and refusing it would say the movement does not exist,
  // which is a different thing and a false one.
  Json::Value out(Json::objectValue);
  out["exerciseId"] = id;
  if (outcome.lastTime) {
    out["session"] = toJson(outcome.lastTime->session);
    if (!outcome.lastTime->routineName.empty()) out["routine"] = outcome.lastTime->routineName;
    out["sets"] = toJson(outcome.lastTime->sets);
  }
  return ToolResult::json(out);
}

// The list and the single read are one tool because one argument does the whole job, and both
// answers wear the same wrapper: a caller that narrowed to one routine parses what it already parses.
ToolResult listRoutines(LogService& log, const UserId& caller, const Json::Value& args) {
  Json::Value out(Json::objectValue);
  if (args["routineId"].isNull()) {
    out["routines"] = toJson(log.routines(caller));
    return ToolResult::json(out);
  }

  std::string id;
  if (std::optional<std::string> bad =
          idArgument(args, "routineId", "Omit it to list every routine you own.", id))
    return ToolResult::failure(*bad);
  std::optional<Routine> one = log.routine(caller, RoutineId{id});
  // Not kNoRoutine: pointing a caller who is already IN this tool back at it is not a next move.
  if (!one)
    return ToolResult::failure("no routine of yours has that id. Call this tool with no routineId "
                               "to list the ones you own.");
  Json::Value routines(Json::arrayValue);
  routines.append(toJson(*one));
  out["routines"] = routines;
  return ToolResult::json(out);
}

// The whole statistics value, optionally narrowed to one movement's line. The narrowing is a
// PROJECTION and nothing else — the same numbers the domain already decided, with the rows a caller
// did not ask for left out — because an account with two years of training answers with a line per
// movement, and that is the one read here that can fill a context window on its own.
ToolResult getStats(LogService& log, const UserId& caller, const Json::Value& args) {
  Statistics stats = log.statistics(caller);
  if (!args["exerciseId"].isNull()) {
    std::string id;
    if (std::optional<std::string> bad =
            idArgument(args, "exerciseId", "Omit it for every movement you have trained.", id))
      return ToolResult::failure(*bad);
    std::erase_if(stats.movements,
                  [&](const MovementProgress& line) { return line.exercise.str() != id; });
  }
  return ToolResult::json(toJson(stats));
}

// --- The writes ------------------------------------------------------------------------------

ToolResult startSession(LogService& log, const UserId& caller, const Json::Value& args) {
  StartOutcome outcome = log.start(caller, parseSessionStart(args));
  if (outcome.error == StartError::idTaken)
    return ToolResult::failure("that workout id is already spent. Mint a different one and start "
                               "again — your OWN id would have replayed, answering with the workout "
                               "already stored under it.");
  if (outcome.error == StartError::unknownRoutine)
    return ToolResult::failure("no routine of yours has that id, so this workout was not started "
                               "rather than started with no plan. Call list_routines, or leave "
                               "routineId out for an ad-hoc workout.");
  if (outcome.error == StartError::alreadyOpen)
    // Reachable only from `joinOpenSession: false`, so the remedy is neither of the other two: a
    // fresh id changes nothing while a workout is open.
    return ToolResult::failure("a workout of yours is already open and this call said it would not "
                               "join one. Close it with finish_session first, or drop "
                               "joinOpenSession to log into it.");
  return ToolResult::json(toJson(*outcome.session));
}

ToolResult logSet(LogService& log, const UserId& caller, const Json::Value& args) {
  std::string session;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions, or start_session to open one.", session))
    return ToolResult::failure(*bad);

  AppendOutcome outcome = log.append(caller, SessionId{session}, parseSetWrite(args));
  if (outcome.error == AppendError::notFound) return ToolResult::failure(kNoSession);
  if (outcome.error == AppendError::finished)
    // A set that ALREADY landed replays fine even now — this answers new ids only.
    return ToolResult::failure("that workout is finished, so no new set can be added to it. Open a "
                               "new one with start_session.");
  if (outcome.error == AppendError::idTaken)
    return ToolResult::failure("that set id is already spent on a set in another workout. Mint a "
                               "different one and send it again.");
  if (outcome.error == AppendError::deleted)
    // The opposite remedy to the one above, and saying so is the whole of this branch: the lifter
    // deleted that set BY HAND, and an agent that answered a spent id by minting a fresh one would
    // put it back — a delete no agent is allowed to make (routes.cpp), undone by an agent all the
    // same. There is nothing to repair and nothing to re-send.
    return ToolResult::failure("that set was deleted from the log. It is not coming back, and a "
                               "fresh id would only log it again — leave it out.");
  if (outcome.error == AppendError::unknownExercise) return ToolResult::failure(kNoExercise);
  return ToolResult::json(toJson(*outcome.set));
}

ToolResult finishSession(LogService& log, const UserId& caller, const Json::Value& args) {
  std::string session;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions for the ids you own.", session))
    return ToolResult::failure(*bad);

  FinishOutcome outcome = log.finish(caller, SessionId{session}, parseFinish(args));
  if (outcome.error == FinishError::notFound) return ToolResult::failure(kNoSession);
  if (outcome.error == FinishError::badInstant)
    return ToolResult::failure("that workout cannot end at that instant — a workout ends at or "
                               "after it began. Read its `startedAt` with get_session.");
  return ToolResult::json(toJson(*outcome.session));
}

// Replace, and create only where there was nothing to replace. Both halves send the same whole
// document, which is the only shape a routine travels in, so one tool serves the two — and the order
// matters: a create against an id the caller already owns is a REPLAY in this product and would
// answer with the routine already stored, silently leaving the edit undone.
ToolResult saveRoutine(LogService& log, const UserId& caller, const Json::Value& args) {
  const RoutineWrite incoming = parseRoutineWrite(args);
  RoutineWriteOutcome outcome = log.replaceRoutine(caller, incoming.id, incoming);
  if (outcome.error == RoutineWriteError::notFound) outcome = log.createRoutine(caller, incoming);

  if (outcome.error == RoutineWriteError::idTaken)
    return ToolResult::failure("that routine id is already spent. Mint a different one and send it "
                               "again.");
  if (outcome.error == RoutineWriteError::unknownExercise)
    return ToolResult::failure("an entry names a movement no catalog holds. Call list_exercises for "
                               "the ids, or create_exercise to add one, then send the whole routine "
                               "again.");
  return ToolResult::json(toJson(*outcome.routine));
}

ToolResult createExercise(LogService& log, const UserId& caller, const Json::Value& args) {
  ExerciseInsertOutcome outcome = log.createExercise(caller, parseExerciseWrite(args));
  if (outcome.error == ExerciseInsertError::idTaken)
    return ToolResult::failure("that movement id is already spent. Mint a different one and send it "
                               "again — and read list_exercises first, in case the movement itself "
                               "is already there under another id.");
  return ToolResult::json(toJson(*outcome.exercise));
}

ToolResult shareSession(LogService& log, const UserId& caller, const Json::Value& args,
                        const std::string& appBaseUrl) {
  std::string session;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions for the ids you own.", session))
    return ToolResult::failure(*bad);

  std::optional<SessionShare> share = log.share(caller, SessionId{session});
  if (!share) return ToolResult::failure(kNoSession);
  // The token alone is not a thing a lifter can hand anybody, so the reply leads with the link it
  // becomes — composed once in the codec, because three surfaces composing it is how two of them
  // ended up handing a coach a page of JSON.
  Json::Value out(Json::objectValue);
  out["url"] = shareUrl(appBaseUrl, share->token);
  out["token"] = share->token;
  out["expiresAt"] = Json::Value::UInt64(share->expiresAtMs);
  return ToolResult::json(out);
}

// --- The deletes -----------------------------------------------------------------------------

ToolResult discardSession(LogService& log, const UserId& caller, const Json::Value& args) {
  std::string session;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions for the ids you own.", session))
    return ToolResult::failure(*bad);

  const DiscardOutcome outcome = log.discard(caller, SessionId{session});
  if (outcome == DiscardOutcome::notFound) return ToolResult::failure(kNoSession);
  if (outcome == DiscardOutcome::open)
    return ToolResult::failure("that workout is still running, and deleting one somebody is logging "
                               "into destroys the sets in flight. Close it with finish_session "
                               "first, then discard it.");
  Json::Value out(Json::objectValue);
  out["deleted"] = true;
  out["sessionId"] = session;
  return ToolResult::json(out);
}

ToolResult deleteRoutine(LogService& log, const UserId& caller, const Json::Value& args) {
  std::string routine;
  if (std::optional<std::string> bad =
          idArgument(args, "routineId", "Call list_routines for the ids you own.", routine))
    return ToolResult::failure(*bad);

  if (!log.deleteRoutine(caller, RoutineId{routine})) return ToolResult::failure(kNoRoutine);
  Json::Value out(Json::objectValue);
  out["deleted"] = true;
  out["routineId"] = routine;
  return ToolResult::json(out);
}

ToolResult revokeShare(LogService& log, const UserId& caller, const Json::Value& args) {
  std::string session;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions for the ids you own.", session))
    return ToolResult::failure(*bad);

  if (!log.revokeShare(caller, SessionId{session})) return ToolResult::failure(kNoShare);
  Json::Value out(Json::objectValue);
  out["revoked"] = true;
  out["sessionId"] = session;
  return ToolResult::json(out);
}

}  // namespace

GymTools::GymTools(LogService& log, std::string appBaseUrl)
    : log_(log), appBaseUrl_(std::move(appBaseUrl)) {}

std::vector<ToolDeclaration> GymTools::declareTools() const { return gymToolCatalog(); }

// Every failure an agent reads names the tool it came from, and names it exactly once: here, on
// whatever `dispatch` refused with. A message that arrives in a transcript without its tool is one
// the agent has to guess the origin of. The two catches are the same promise for a throw — the
// domain's refusals travel as exceptions by design (InvalidTraining, thrown where an entity is
// constructed from untrusted input) and its sentences are already the actionable ones, so they are
// forwarded verbatim rather than flattened into one "could not read that" the way the browser edge
// flattens them.
ToolResult GymTools::callTool(const std::string& name, const Json::Value& arguments,
                              const ToolCaller& caller) {
  try {
    ToolResult outcome = dispatch(name, arguments, caller.user);
    if (!outcome.isError) return outcome;
    return ToolResult::failure(name + ": " + outcome.content[0]["text"].asString());
  } catch (const std::bad_alloc&) {
    throw;  // not a tool failure: an exhausted process must die loudly, not answer politely
  } catch (const InvalidTraining& malformed) {
    // Nothing landed: every one of these is thrown while an entity is being built, which is always
    // before the write that would have stored it.
    return ToolResult::failure(name + ": " + malformed.what());
  } catch (const std::exception& error) {
    // The detail goes to the log, never into the model's context: what escapes a repository is a
    // connection string, a host, a role. stderr rather than LOG_ERROR because on the stdio transport
    // stdout IS the protocol channel (platform/infra/mcp_main.cpp).
    std::cerr << "mcp tool " << name << " failed: " << error.what() << "\n";
    return ToolResult::failure(name + ": that call failed inside the server; the detail is in the "
                               "server log. Read the workout back before retrying a write, and "
                               "reuse the SAME id if you do.");
  }
}

ToolResult GymTools::dispatch(const std::string& name, const Json::Value& arguments,
                              const UserId& caller) {
  // The outermost shape: everything below reads `arguments` by key, and jsoncpp throws rather than
  // answers when a key is asked of something that is not an object.
  if (!arguments.isObject())
    return ToolResult::failure("arguments must be a JSON object of this tool's named arguments, got " +
                               typeName(arguments));

  if (name == "list_exercises")  return listExercises(log_, caller);
  if (name == "list_sessions")   return listSessions(log_, caller, arguments);
  if (name == "get_session")     return getSession(log_, caller, arguments);
  if (name == "last_time")       return lastTime(log_, caller, arguments);
  if (name == "list_routines")   return listRoutines(log_, caller, arguments);
  if (name == "get_stats")       return getStats(log_, caller, arguments);

  if (name == "start_session")   return startSession(log_, caller, arguments);
  if (name == "log_set")         return logSet(log_, caller, arguments);
  if (name == "finish_session")  return finishSession(log_, caller, arguments);
  if (name == "save_routine")    return saveRoutine(log_, caller, arguments);
  if (name == "create_exercise") return createExercise(log_, caller, arguments);
  if (name == "share_session")   return shareSession(log_, caller, arguments, appBaseUrl_);

  if (name == "discard_session") return discardSession(log_, caller, arguments);
  if (name == "delete_routine")  return deleteRoutine(log_, caller, arguments);
  if (name == "revoke_share")    return revokeShare(log_, caller, arguments);

  // The whole-server answer belongs to CompositeToolHost, which is the only thing that knows what
  // else is connected; a name that reaches this far named nothing in the gym surface.
  return ToolResult::failure("no such gym tool — call tools/list for the surface this connection "
                             "may use.");
}

}
