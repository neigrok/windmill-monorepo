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

ToolResult listExercises(CatalogService& catalog, const UserId& caller) {
  Json::Value out(Json::objectValue);
  out["exercises"] = toJson(catalog.catalog(caller));
  return ToolResult::json(out);
}

ToolResult listSessions(TrainingService& training, const UserId& caller, const Json::Value& args,
                        ReadReceipt& served) {
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
  for (const LogRow& row : training.log(caller, cursor)) {
    // A page names workouts and counts their sets; it hands over no set rows, so it claims none.
    served.sawSession(row.summary.session.id, row.summary.session.startedAtMs);
    sessions.append(toJson(row));
  }
  Json::Value out(Json::objectValue);
  out["sessions"] = sessions;
  return ToolResult::json(out);
}

// One workout with its sets, and — asked for — the finish readout over the same rows. The two ride
// on one tool because they are one question about one workout, and a second tool for the second half
// would cost every connection a slot in tools/list to save this one an argument.
ToolResult getSession(TrainingService& training, const UserId& caller, const Json::Value& args,
                      ReadReceipt& served) {
  std::string id;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions for the ids you own.", id))
    return ToolResult::failure(*bad);
  if (!args["review"].isNull() && !args["review"].isBool())
    return ToolResult::failure("\"review\" must be true or false.");

  std::optional<SessionDetail> detail = training.detail(caller, SessionId{id});
  if (!detail) return ToolResult::failure(kNoSession);
  served.sawSession(detail->session.id, detail->session.startedAtMs);
  for (const Set& set : detail->sets) served.sawSet(set.id, set.completedAtMs);
  Json::Value out(Json::objectValue);
  out["session"] = toJson(detail->session);
  out["sets"] = toJson(detail->sets);
  if (args["review"].isBool() && args["review"].asBool())
    if (std::optional<Review> readout = training.review(caller, SessionId{id}))
      out["review"] = toJson(*readout);
  return ToolResult::json(out);
}

ToolResult lastTime(TrainingService& training, const UserId& caller, const Json::Value& args,
                    ReadReceipt& served) {
  std::string id;
  if (std::optional<std::string> bad =
          idArgument(args, "exerciseId", "Call list_exercises for the catalog.", id))
    return ToolResult::failure(*bad);

  LastTimeOutcome outcome = training.lastTime(caller, ExerciseId{id});
  if (outcome.error == LastTimeError::unknownExercise) return ToolResult::failure(kNoExercise);
  // A first-ever movement answers with the movement and nothing else. That absence is the whole
  // answer — "you have never trained this" — and refusing it would say the movement does not exist,
  // which is a different thing and a false one.
  Json::Value out(Json::objectValue);
  out["exerciseId"] = id;
  if (outcome.lastTime) {
    served.sawSession(outcome.lastTime->session.id, outcome.lastTime->session.startedAtMs);
    for (const Set& set : outcome.lastTime->sets) served.sawSet(set.id, set.completedAtMs);
    out["session"] = toJson(outcome.lastTime->session);
    if (!outcome.lastTime->routineName.empty()) out["routine"] = outcome.lastTime->routineName;
    out["sets"] = toJson(outcome.lastTime->sets);
  }
  return ToolResult::json(out);
}

// The list and the single read are one tool because one argument does the whole job, and both
// answers wear the same wrapper: a caller that narrowed to one routine parses what it already parses.
//
// The pending proposals ride along rather than minting `list_proposals` and `get_proposal` of their
// own: a proposal always targets a routine, so the read an agent already makes is the read that
// answers "is something of mine waiting on this day". It is the head alone — an id, a summary, a
// count — because a list that shipped every diff row of every proposal would spend a context window
// to draw a dot.
ToolResult listRoutines(ProgramService& program, const UserId& caller, const Json::Value& args) {
  Json::Value out(Json::objectValue);
  const std::vector<ProposalHead> pending = program.proposals(caller, ProposalQuery{std::nullopt, true});
  if (args["routineId"].isNull()) {
    out["routines"] = toJson(program.routines(caller), pending);
    return ToolResult::json(out);
  }

  std::string id;
  if (std::optional<std::string> bad =
          idArgument(args, "routineId", "Omit it to list every routine you own.", id))
    return ToolResult::failure(*bad);
  std::optional<Routine> one = program.routine(caller, RoutineId{id});
  // Not kNoRoutine: pointing a caller who is already IN this tool back at it is not a next move.
  if (!one)
    return ToolResult::failure("no routine of yours has that id. Call this tool with no routineId "
                               "to list the ones you own.");
  out["routines"] = toJson(std::vector<Routine>{*one}, pending);
  return ToolResult::json(out);
}

// The whole statistics value, optionally narrowed to one movement's line. The narrowing is a
// PROJECTION and nothing else — the same numbers the domain already decided, with the rows a caller
// did not ask for left out — because an account with two years of training answers with a line per
// movement, and that is the one read here that can fill a context window on its own.
ToolResult getStats(TrainingService& training, const UserId& caller, const Json::Value& args,
                    ReadReceipt& served) {
  // The narrowing is settled BEFORE the store is read, so a refusal costs no query and — the reason
  // the order is load-bearing — marks nothing on the receipt. A call that answers with a refusal
  // hands the model no rows, and the receipt only ever counts rows it handed over.
  std::string only;
  if (!args["exerciseId"].isNull())
    if (std::optional<std::string> bad =
            idArgument(args, "exerciseId", "Omit it for every movement you have trained.", only))
      return ToolResult::failure(*bad);

  Statistics stats = training.statistics(caller);
  // The weeks and nothing else. A movement's line is a PROJECTION over sets — one point per session,
  // chosen by the store — so counting a point as a set would claim a row this reply never handed
  // over, and would double-count the one `get_session` hands over whole.
  for (const TrainingWeek& week : stats.weeks) served.sawWeek(week.startedAtMs);
  if (!only.empty())
    std::erase_if(stats.movements,
                  [&](const MovementProgress& line) { return line.exercise.str() != only; });
  return ToolResult::json(toJson(stats));
}

// --- The writes ------------------------------------------------------------------------------

ToolResult startSession(TrainingService& training, const UserId& caller, const Json::Value& args) {
  StartOutcome outcome = training.start(caller, parseSessionStart(args));
  if (outcome.error == StartError::idTaken)
    return ToolResult::failure("that workout id is already spent. Mint a different one and start "
                               "again — your OWN id would have replayed, answering with the workout "
                               "already stored under it.");
  if (outcome.error == StartError::unknownRoutine)
    return ToolResult::failure("no routine of yours has that id, so this workout was not started "
                               "rather than started with no plan. Call list_routines, or leave "
                               "routineId out for an ad-hoc workout.");
  if (outcome.error == StartError::clockAhead)
    return ToolResult::failure("that startedAt is " +
                               std::to_string((outcome.clockAheadMs + 59'999) / 60'000) +
                               " minutes ahead of the log's clock, and a workout cannot start in the "
                               "future — the log would be locked behind it until it aged out. Send "
                               "the instant the workout actually began (now, for one starting now), "
                               "in epoch milliseconds.");
  if (outcome.error == StartError::alreadyOpen)
    // Reachable only from `joinOpenSession: false`, so the remedy is neither of the other two: a
    // fresh id changes nothing while a workout is open.
    return ToolResult::failure("a workout of yours is already open and this call said it would not "
                               "join one. Close it with finish_session first, or drop "
                               "joinOpenSession to log into it.");
  return ToolResult::json(toJson(*outcome.session));
}

ToolResult logSet(TrainingService& training, const UserId& caller, const Json::Value& args) {
  std::string session;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions, or start_session to open one.", session))
    return ToolResult::failure(*bad);

  AppendOutcome outcome = training.append(caller, SessionId{session}, parseSetWrite(args));
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

ToolResult finishSession(TrainingService& training, const UserId& caller, const Json::Value& args) {
  std::string session;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions for the ids you own.", session))
    return ToolResult::failure(*bad);

  FinishOutcome outcome = training.finish(caller, SessionId{session}, parseFinish(args));
  if (outcome.error == FinishError::notFound) return ToolResult::failure(kNoSession);
  if (outcome.error == FinishError::badInstant)
    return ToolResult::failure("that workout cannot end at that instant — a workout ends at or "
                               "after it began. Read its `startedAt` with get_session.");
  return ToolResult::json(toJson(*outcome.session));
}

// A NEW day of the program, and the predicate is what decides that this one writes: a routine that
// does not exist yet is `fresh`, and the rule calls a mutation that brings something into being a
// record — it takes nothing away, and the lifter reads it, edits it or deletes it the moment they
// open Routines.
//
// The routine is resolved FIRST, and what that resolve decides is the difference between a REPLAY
// and an EDIT wearing a create's clothes. A lost reply is resent verbatim, so a stored routine the
// incoming document matches exactly is the replay this product promises everywhere else and answers
// with the stored row. A stored routine it does NOT match is this tool's name disagreeing with the
// predicate — a change to a day that already stands — and it is sent to the tool whose name is true
// for that case rather than quietly replaying and leaving the caller's edit silently undone.
ToolResult createRoutine(ProgramService& program, const UserId& caller, const Json::Value& args,
                         ProposalDoor door) {
  static_assert(classify(Subject::program, Standing::fresh) == Mutation::record);
  const RoutineWrite incoming = parseRoutineWrite(args);
  if (std::optional<Routine> standing = program.routine(caller, incoming.id)) {
    const Routine sent{incoming.id, caller, incoming.name, incoming.position, incoming.entries};
    if (standing->name == sent.name && standing->position == sent.position &&
        standing->entries == sent.entries)
      return ToolResult::json(toJson(*standing));
    return ToolResult::failure("that routine already stands and this document is not the one it "
                               "holds, so this is a change rather than the replay of a lost reply. "
                               "A day of the program that already stands is not this tool's to "
                               "rewrite: send it to propose_routine_change, which hands the lifter "
                               "a typed diff and changes nothing until they tap Apply.");
  }

  // The door rides onto the creation row of the routine's history, because "who made this day of my
  // program" is a question a lifter is entitled to an answer to — and `created by you` about a day
  // an agent typed would be this product putting words in their mouth.
  RoutineWriteOutcome outcome = program.createRoutine(caller, incoming, door);
  if (outcome.error == RoutineWriteError::idTaken)
    return ToolResult::failure("that routine id is already spent. Mint a different one and send it "
                               "again.");
  if (outcome.error == RoutineWriteError::unknownExercise)
    return ToolResult::failure("an entry names a movement no catalog holds. Call list_exercises for "
                               "the ids, or create_exercise to add one, then send the whole routine "
                               "again.");
  return ToolResult::json(toJson(*outcome.routine));
}

// THE RECEIPT, and it is the one reply on this surface written to be UNMISTAKABLE. An agent that
// read a success shaped like a write would tell its human the routine had changed, and a
// well-behaved agent turned into a liar is the worst thing this wave could produce. So there is no
// routine in this object at all: a proposal id, the state it is actually in, the diff, and where a
// human goes to decide.
ToolResult proposalReceipt(const RoutineProposal& proposal, const std::string& appBaseUrl) {
  Json::Value out(Json::objectValue);
  out["proposal"] = toJson(proposal);
  out["reviewUrl"] = proposalUrl(appBaseUrl, proposal.head.id);
  if (proposal.head.state == ProposalState::pending)
    out["note"] = "Nothing has changed. " + proposal.baseName +
                  " still reads exactly as it did, and this proposal is waiting in the lifter's app "
                  "until they open it and tap Apply — no tool on this connection can apply it. Say "
                  "so when you answer: the routine is unchanged and something is waiting for them.";
  else if (proposal.head.state == ProposalState::applied)
    out["note"] = "This proposal was already applied by the lifter — this is the record of it, not "
                  "a second change.";
  else if (proposal.head.state == ProposalState::dismissed)
    out["note"] = "The lifter dismissed this proposal. Nothing changed, and it stays in the "
                  "routine's history. Do not resend the same id; propose again only if you have "
                  "something different to say.";
  else
    out["note"] = "This proposal was superseded — the routine moved after it was minted, so it can "
                  "no longer be applied. Read the routine again with list_routines before you "
                  "propose anything else.";
  return ToolResult::json(out);
}

// The mint, and the two tools below are the same three lines because they are the same act with two
// intents. `classify` is what says so out loud: a day of the program that already stands is
// `existing`, and the rule calls changing one an intent — so this writes nothing and hands back a
// proposal.
ToolResult mintOutcome(const ProposalMintOutcome& outcome, const std::string& appBaseUrl) {
  if (outcome.error == ProposalMintError::unknownRoutine)
    return ToolResult::failure("no routine of yours has that id, so there is nothing to propose a "
                               "change to. Call list_routines for the ids you own, or "
                               "create_routine to add a day that does not exist yet.");
  if (outcome.error == ProposalMintError::idTaken)
    return ToolResult::failure("that proposal id is already spent. Mint a different one and send it "
                               "again — your OWN id would have replayed, answering with the "
                               "proposal already waiting under it.");
  if (outcome.error == ProposalMintError::idReused)
    // The asymmetry with the replay above is the whole reason this refusal exists, and it is
    // create_routine's refusal wearing the other tool's clothes: an id already holding a DIFFERENT
    // proposal answered with the stored one would throw this document away and hand back a receipt
    // saying something is waiting for the lifter — something the caller never wrote.
    return ToolResult::failure("that proposal id already holds a DIFFERENT proposal of yours, so "
                               "this is a second idea wearing a spent id rather than the replay of "
                               "a lost reply. NOTHING WAS MINTED and the proposal standing under "
                               "that id is untouched — only an identical document replays. Mint a "
                               "fresh id and send this one again.");
  if (outcome.error == ProposalMintError::noChange)
    return ToolResult::failure("that document is what the routine already says, so there is nothing "
                               "to propose. Read it again with list_routines and send back what you "
                               "actually mean to change.");
  if (outcome.error == ProposalMintError::unknownExercise)
    return ToolResult::failure("an entry names a movement no catalog holds, so this proposal was "
                               "not minted rather than minted as something the lifter could not "
                               "apply. Call list_exercises for the ids, or create_exercise to add "
                               "one, then send the whole document again.");
  return proposalReceipt(*outcome.proposal, appBaseUrl);
}

ToolResult proposeRoutineChange(ProgramService& program, const UserId& caller, const Json::Value& args,
                                const ProposalSource& source, const std::string& appBaseUrl) {
  static_assert(classify(Subject::program, Standing::existing) == Mutation::intent);
  return mintOutcome(program.propose(caller, parseProposalWrite(args, source)), appBaseUrl);
}

ToolResult createExercise(CatalogService& catalog, const UserId& caller, const Json::Value& args) {
  ExerciseInsertOutcome outcome = catalog.createExercise(caller, parseExerciseWrite(args));
  if (outcome.error == ExerciseInsertError::idTaken)
    return ToolResult::failure("that movement id is already spent. Mint a different one and send it "
                               "again — and read list_exercises first, in case the movement itself "
                               "is already there under another id.");
  return ToolResult::json(toJson(*outcome.exercise));
}

ToolResult shareSession(TrainingService& training, const UserId& caller, const Json::Value& args,
                        const std::string& appBaseUrl) {
  std::string session;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions for the ids you own.", session))
    return ToolResult::failure(*bad);

  std::optional<SessionShare> share = training.share(caller, SessionId{session});
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

ToolResult discardSession(TrainingService& training, const UserId& caller, const Json::Value& args) {
  std::string session;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions for the ids you own.", session))
    return ToolResult::failure(*bad);

  const DiscardOutcome outcome = training.discard(caller, SessionId{session});
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

// The other intent, at the level that buys the right to PROPOSE a destructive change — and buys
// nothing else, because `gym:delete` does not imply apply any more than `gym:write` does.
ToolResult proposeRoutineRemoval(ProgramService& program, const UserId& caller, const Json::Value& args,
                                 const ProposalSource& source, const std::string& appBaseUrl) {
  static_assert(classify(Subject::program, Standing::existing) == Mutation::intent);
  std::string id;
  if (std::optional<std::string> bad =
          idArgument(args, "id", "Mint one for this proposal — `prop_` + hex is the house shape.",
                     id))
    return ToolResult::failure(*bad);
  std::string routine;
  if (std::optional<std::string> bad =
          idArgument(args, "routineId", "Call list_routines for the ids you own.", routine))
    return ToolResult::failure(*bad);
  std::string summary;
  if (!args["summary"].isNull()) {
    if (!args["summary"].isString())
      return ToolResult::failure("\"summary\" must be one sentence of text.");
    summary = args["summary"].asString();
  }

  return mintOutcome(
      program.proposeRemoval(caller, ProposalId{id}, RoutineId{routine}, summary, source), appBaseUrl);
}

ToolResult revokeShare(TrainingService& training, const UserId& caller, const Json::Value& args) {
  std::string session;
  if (std::optional<std::string> bad =
          idArgument(args, "sessionId", "Call list_sessions for the ids you own.", session))
    return ToolResult::failure(*bad);

  if (!training.revokeShare(caller, SessionId{session})) return ToolResult::failure(kNoShare);
  Json::Value out(Json::objectValue);
  out["revoked"] = true;
  out["sessionId"] = session;
  return ToolResult::json(out);
}

}  // namespace

GymTools::GymTools(TrainingService& training, CatalogService& catalog, ProgramService& program,
                   std::string appBaseUrl)
    : training_(training), catalog_(catalog), program_(program),
      appBaseUrl_(std::move(appBaseUrl)) {}

// THE RETIREMENT ANSWER. An agent written against the old catalog calls one of these on its very
// first turn after the deploy, and the answer it gets is a connected user's whole first experience
// of the wave. It names what replaced it rather than saying "no such tool", because the true and
// useless answer costs a round trip and the FALSE one — "this connection was not granted gym:write"
// — would be a lie: the level was granted, the tool was retired. get_preferences was retired with
// no replacement, which its sentence has to say plainly or it sends an agent hunting for the tool
// that took over — its name was vague enough that agents reached for it at the top of a turn
// whether or not the turn was about equipment, and what it answered with was a plate inventory this
// product no longer keeps.
std::vector<ToolRetirement> GymTools::retiredTools() const {
  return {
      ToolRetirement{"save_routine", "propose_routine_change",
                     "retired on 2026-08-12, and the level you hold was not the problem. Use "
                     "propose_routine_change to change a day of the program that already stands — it "
                     "hands the lifter a typed diff and changes nothing until they tap Apply — or "
                     "create_routine to add one that does not exist yet, which still lands "
                     "immediately."},
      ToolRetirement{"delete_routine", "propose_routine_removal",
                     "retired on 2026-08-12, and the level you hold was not the problem. Use "
                     "propose_routine_removal: it puts the day's lines in front of the lifter as a "
                     "diff of what would go, and nothing is deleted until they tap Apply."},
      ToolRetirement{"get_preferences", "",
                     "retired on 2026-08-13, and nothing replaced it. gym no longer keeps a plate "
                     "inventory or a bar weight, and the rest target and reading unit it also carried "
                     "are the lifter's own dials rather than context for a proposal. Propose loads in "
                     "kilograms and let them round at the rack."},
  };
}

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
  // The MCP door: a connected agent, named by the connection the transport resolved — its id and its
  // registered name — so a proposal says which agent asked, and two agents on one account each hold
  // their own. Every call stands alone, so the reply's envelope is the whole accounting there is.
  ReadReceipt oneReply;
  return callTool(name, arguments, caller,
                  ProposalSource{ProposalDoor::mcp, caller.connection.id, caller.connection.name,
                                 std::nullopt},
                  oneReply);
}

ToolResult GymTools::callTool(const std::string& name, const Json::Value& arguments,
                              const ToolCaller& caller, const ProposalSource& source,
                              ReadReceipt& run) {
  ReadReceipt served;
  try {
    ToolResult outcome = dispatch(name, arguments, caller.user, source, served);
    // A REFUSAL SERVED NOTHING, SO IT COUNTS NOTHING. The tool answers with one sentence and no rows,
    // and the run's line under the answer is the lifter's way of checking a claim without trusting
    // it — a refused read that still moved the number would be the receipt claiming a row it never
    // handed to the model (domain/ReadReceipt.h), which is the one thing it promises never to do.
    // The two throw paths below say the same thing by never reaching this line.
    if (outcome.isError) return ToolResult::failure(name + ": " + outcome.content[0]["text"].asString());
    run.merge(served);
    // THE READ, IN THE ENVELOPE. It is stated where the rows were served rather than drawn in
    // somebody's chrome, so a lifter's own Claude reads the same accounting Ask prints — and so that
    // the number under an answer is one we counted rather than one a model could invent. A reply that
    // served no log rows says nothing, because "read 0 sets" is noise rather than a fact.
    if (!served.tally().anything() || !outcome.payload.isObject()) return outcome;
    Json::Value answer = outcome.payload;
    answer["read"] = toJson(served.tally());
    return ToolResult::json(answer);
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
                              const UserId& caller, const ProposalSource& source,
                              ReadReceipt& served) {
  // The outermost shape: everything below reads `arguments` by key, and jsoncpp throws rather than
  // answers when a key is asked of something that is not an object.
  if (!arguments.isObject())
    return ToolResult::failure("arguments must be a JSON object of this tool's named arguments, got " +
                               typeName(arguments));

  if (name == "list_exercises")  return listExercises(catalog_, caller);
  if (name == "list_sessions")   return listSessions(training_, caller, arguments, served);
  if (name == "get_session")     return getSession(training_, caller, arguments, served);
  if (name == "last_time")       return lastTime(training_, caller, arguments, served);
  if (name == "list_routines")   return listRoutines(program_, caller, arguments);
  if (name == "get_stats")       return getStats(training_, caller, arguments, served);

  if (name == "start_session")   return startSession(training_, caller, arguments);
  if (name == "log_set")         return logSet(training_, caller, arguments);
  if (name == "finish_session")  return finishSession(training_, caller, arguments);
  if (name == "create_routine")  return createRoutine(program_, caller, arguments, source.door);
  if (name == "propose_routine_change")
    return proposeRoutineChange(program_, caller, arguments, source, appBaseUrl_);
  if (name == "create_exercise") return createExercise(catalog_, caller, arguments);
  if (name == "share_session")   return shareSession(training_, caller, arguments, appBaseUrl_);

  if (name == "discard_session") return discardSession(training_, caller, arguments);
  if (name == "propose_routine_removal")
    return proposeRoutineRemoval(program_, caller, arguments, source, appBaseUrl_);
  if (name == "revoke_share")    return revokeShare(training_, caller, arguments);

  // A retired name never reaches here on purpose: the retirements live in retiredTools(), and the
  // host above — the composite over MCP, Ask in-process — answers them with their sentence before
  // this dispatcher is asked. Only a name gym never had falls through, and the whole-server answer
  // for that belongs to CompositeToolHost, which is the only thing that knows what else is connected.
  return ToolResult::failure("no such gym tool — call tools/list for the surface this connection "
                             "may use.");
}

}
