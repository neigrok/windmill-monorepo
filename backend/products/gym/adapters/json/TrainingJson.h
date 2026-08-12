#pragma once

#include "products/gym/application/LogService.h"

#include <json/value.h>

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// The wire boundary for training data. A cross-surface contract — web, iOS, Android and later the
// MCP tools all speak it — so it lives in one place and changes deliberately. Instants are epoch-ms
// numbers, weights are numbers in kg. Optional fields are OMITTED when absent (rpe, finishedAt,
// routineId, plan, lastTrainedAt, targetReps, targetWeightKg, restSeconds, topSet, topE1rm), never
// null; note is always present.
//
//   session in  : { "id": "ses_…", "startedAt": ms, "joinOpenSession"?: bool, "routineId"?: "rt_…" }
//   set in      : { "id": "set_…", "exerciseId": "…", "weightKg": n, "reps": n, "completedAt": ms,
//                   "kind"?: "warmup"|"working"|"drop"|"failure", "rpe"?: n, "note"?: "…" }
//   fix in      : { "weightKg"?: n, "reps"?: n, "kind"?: "…", "rpe"?: n|null, "note"?: "…" }
//                                                       PATCH /v1/gym/sessions/{id}/sets/{setId}
//   routine in  : { "id": "rt_…", "name": "…", "position": n,
//                   "entries": [ { "exerciseId": "…", "targetSets": n, "targetReps"?: n,
//                                  "targetWeightKg"?: n, "restSeconds"?: n } ] }
//   movement in : { "id": "ex_…", "name": "…", "pattern": "squat"|…, "equipment": "barbell"|…,
//                   "stepKg"?: n }
//   rename in   : { "name": "…" }                       PATCH /v1/gym/exercises/{id}
//   settings i/o: { "units": "kg"|"lb", "barWeightKg": n, "platesKg": [n, …], "restSeconds"?: n,
//                   "restSound": bool, "confirmHaptic": bool, "confirmSound": bool }
//                                                       GET · PUT /v1/gym/preferences
//   session out : { "id", "startedAt", "finishedAt"?, "routineId"?, "plan"? }
//   log row out : the session, plus { "setCount", "workingSetCount", "tonnageKg",
//                                     "exercises": ["…"], "topSet"?: { "weightKg", "reps" },
//                                     "topE1rm"?: n, "record": bool, "closedItself": bool }
//   set out     : { "id", "exerciseId", "setNumber", "weightKg", "reps", "kind", "rpe"?, "note",
//                   "completedAt" }
//   exercise out: { "id", "name", "pattern", "equipment", "stepKg", "custom" }
//   last sets out: { "movements": [ { "exerciseId", "weightKg", "reps", "at" } ] }
//                                                       GET /v1/gym/exercises/last
//   routine out : { "id", "name", "position", "revision", "lastTrainedAt"?,
//                   "entries": [ { "position", "exerciseId", "targetSets", "targetReps"?,
//                                  "targetWeightKg"?, "restSeconds"? } ],
//                   "pendingProposal"?: <proposal head> }
//   proposal in : { "id": "prop_…", "routineId": "rt_…", "name"?: "…", "summary"?: "…",
//                   "entries": [ <the same entry shape a routine takes> ] }
//   proposal head out: { "id", "routineId", "intent": "revise"|"remove",
//                        "state": "pending"|"applied"|"dismissed"|"superseded",
//                        "summary", "changeCount": n, "createdAt": ms, "settledAt"?: ms,
//                        "source": { "door": "mcp"|"ask", "connection"?: "…", "agent"?: "…" } }
//   proposal out: the head, plus { "baseRevision": n, "baseName": "…", "name": "…",
//                   "changes": [ { "position", "kind": "kept"|"added"|"removed"|"retargeted",
//                                  "exerciseId",
//                                  "before"?: { "sets", "reps"?, "weightKg"?, "restSeconds"? },
//                                  "after"?:  { "sets", "reps"?, "weightKg"?, "restSeconds"? },
//                                  "loggedSets"?: n } ] }
//
// `revision` is the routine's concurrency token: a client READS it and never sends it — the store
// is what moves it. `pendingProposal` is present only while one is waiting, so its absence is the
// whole of "this day of the program has nothing to review".
//
// A proposal's `changes` are its DIFF and its DOCUMENT at once (domain/Proposal.h): the rows up to
// the first `removed` are the run the routine takes on, in order, and the rest are the lines it
// takes away. `before` is absent on an `added` row and `after` on a `removed` one, both by
// construction rather than by omission. `loggedSets` rides on a `removed` row alone and is counted
// at READ time — it is §D14's *41 logged sets kept*, and the whole point of it is to be true when a
// lifter reads it. `connection` and `agent` are omitted while the transport carries neither.
//   plan        : { "routine": "Push A",
//                   "entries": [ { "exerciseId", "sets", "reps"?, "weightKg"?, "restSeconds"? } ] }
//
// An absent rep target — on a routine entry, on the frozen plan's line, and on the review's
// `planned` — is the canon's `3 × max`: the chin-up line, which a required targetReps could not
// express at all. It is an omission that MEANS something, exactly like an absent target weight,
// and every surface draws it as `max`.
//   stats out   : { "weeks": [ { "startedAt", "sessions", "workingSets" } ],
//                   "movements": [ { "exerciseId", "lastTrainedAt",
//                                    "points":    [ { "at", "weightKg", "reps", "e1rm"? } ],
//                                    "bestE1rm"?: { "weightKg", "reps", "at", "e1rm"? },
//                                    "heaviest"?: { "weightKg", "reps", "at", "e1rm"? } } ] }
//   record out  : { "exercise": { "id", "name", … },  "routineCount": n,  "sessionCount": n,
//                   "bestE1rm"?: { "weightKg", "reps", "at", "e1rm" },
//                   "heaviest"?: { "weightKg", "reps", "at", "e1rm"? },
//                   "e1rmSeries"?: [ { "at", "weightKg", "reps", "e1rm" } ],   oldest first
//                   "records"?:    [ { "at", "weightKg", "reps", "e1rm" } ],   newest first
//                   "recentDays"?: [ { "sessionId", "startedAt", "sets": [ … ] } ] }
//
// The record page is the one reply here whose LISTS are omitted when empty rather than sent as
// `[]`, and that is the whole shape of it: a movement in the catalog you have never lifted draws a
// page that says so, not a chart frame with no bars in it, and a bodyweight or band-assisted
// movement — where Epley is undefined — carries no `bestE1rm`, no `e1rmSeries` and no `records`
// while still drawing its heaviest tile and its sets. Both counts are always present, because zero
// is a real answer there and the page prints it (`never logged`).
//   shared out  : { "startedAt", "finishedAt"?, "routine"?,
//                   "sets": [ { "exercise", "setNumber", "weightKg", "reps", "kind", "rpe"?,
//                               "note", "completedAt" } ] }
//   review out  : { "stats": { "durationMs", "workingSets", "topE1rm"? }, "slight": bool,
//                   "record"?: { "kind": "e1rm"|"heaviest"|"reps-at-weight", "exerciseId", "value",
//                                "weightKg", "reps", "previous", "previousAt" },
//                   "against"?: { "sessionId", "routine"?, "startedAt",
//                                 "movements": [ { "exerciseId",
//                                                  "now":     { "weightKg", "reps", "sets" },
//                                                  "before"?: { "weightKg", "reps", "sets" },
//                                                  "planned"?: { "sets", "reps"?, "weightKg"? } } ] } }

// A routine travels as its WHOLE document, on the create and on the replace alike, and its ENTRY
// ORDER is the routine's order: entries in carry no position, the codec numbers them 1..n from the
// order they arrived in, and entries out carry the number so a client can print it. A per-entry id
// would be a second identity to keep in step with the store's key, which is (routine_id, position).
// On a replace the PATH names the routine; the body's `id` is the same routine on any read-modify-
// write and the path is what the store is asked for.

// `plan` is the one shape written at BOTH edges — jsonb on the session row and an object on the
// wire — so its codec pair lives here, once, and PgTrainingRepository serializes through it. The
// name stays a plain STRING at the top level because the prefill's SQL type-checks exactly that
// (`jsonb_typeof(plan->'routine') = 'string'`); anything else there and the card silently loses the
// day of the program it was trained on. Reading a stored plan CLAMPS the way every other stored
// value does — a blob no writer of ours can produce reads as the sane part of itself rather than
// failing the whole session read.

// Every instant on the wire — startedAt, completedAt, finishedAt — is parsed against the domain's
// (0, kMaxInstantMs] band, so a unit-confused device is refused here rather than at to_timestamp().
// The same ceiling is the log cursor's "no cursor: from now".

// The review travels ONE WAY and has no parse half: every number in it is computed from stored rows
// on each read, so there is nothing for a client to send back and nothing to keep in step. Its
// absences are the shape — `topE1rm` is absent when nothing was loaded, `record` on the ~190
// sessions in 200 that earn none, `against` for an ad-hoc session or one with no earlier match, and
// `routine` when the session it stands against carries no name — and a slight session says so in
// `slight` while omitting both of the lines it would otherwise have earned.
//
// `joinOpenSession` is the caller's intent, not a field about the session: omitted it is true, the
// Start that continues whatever workout is open (the phone's, and the handoff's). `false` is the
// Start that means "create exactly this session, which is not now" — backfill and lift-import — and
// it is refused 409 `session-already-open` rather than joined.

SessionStart parseSessionStart(const Json::Value& body);   // throws InvalidTraining
SetWrite parseSetWrite(const Json::Value& body);           // throws InvalidTraining
// A correction carries only the fields it changes, and it is STRICT about the ones it does not —
// the rule parseExerciseRename already keeps, for the reason it keeps it: a body naming `exerciseId`
// answered 200 with the movement unchanged would be a write doing less than it said. The three
// fields refused here are refused on purpose and not for want of plumbing (domain/Training.h says
// which and why). `rpe: null` is the one null that means something — clear it — and every other
// field type-checks strictly; an EMPTY body is legal and changes nothing, which is what makes a
// replay of a lost reply free.
SetFix parseSetFix(const Json::Value& body);               // throws InvalidTraining
std::uint64_t parseFinish(const Json::Value& body);        // { "finishedAt": ms }; throws InvalidTraining
RoutineWrite parseRoutineWrite(const Json::Value& body);   // throws InvalidTraining
// What an agent proposes, and it reads a routine's entries through the very same parser a routine
// write does — an agent is told to read `list_routines`, change what it means and send all of it
// back, so the two shapes have to be one shape or that instruction is a trap. `position` is
// deliberately not a field here (application/LogService.h says why), and the source rides beside
// the body because provenance is the caller's fact rather than the body's.
ProposalWrite parseProposalWrite(const Json::Value& body, const ProposalSource& source);
ExerciseWrite parseExerciseWrite(const Json::Value& body); // throws InvalidTraining
// The rename carries ONE field, because one field is what a rename changes. The id is the path's,
// and everything else about a movement — its pattern, its equipment, its step — is not a thing this
// write may touch: a body that named them would be a body promising an edit this product refuses.
std::string parseExerciseRename(const Json::Value& body);  // throws InvalidTraining
// The settings document, whole, every time. The OWNER is the caller's and never the body's, so the
// entity is built here rather than through a `…Write` struct: there is nothing left for the service
// to decide, and one fewer shape between the wire and the value that gets stored.
//
// Every field is optional and an OMITTED one takes its default, which is what "the document is
// this" has to mean — a whole-document PUT that quietly kept a value the body did not name would be
// keeping something the sender cannot see and cannot clear. Present values type-check strictly, and
// an unknown unit is refused rather than downgraded. Every refusal it makes is an InvalidPreference
// carrying a machine `code`, because five independent values arrive at once and "could not read
// that" would leave a client guessing which of the five to fix.
GymPreferences parsePreferences(const Json::Value& body, const UserId& user);  // throws InvalidPreference

Json::Value toJson(const Session& session);
// The log row carries the estimate the application put on it, not the store's summary alone: a
// client that computed an e1RM from `topSet` would be the second copy of Epley in that language,
// which is the one thing §11.5 does not allow — and it would be a WRONG second copy, because
// `topE1rm` is the best estimate over every working set the session held and `topSet` is only its
// heaviest one. The two are the same number on a straight-sets day and differ on every session with
// back-offs in it.
//
// Both `topE1rm` and every other double here leave as a JSON number, and the number is the double —
// not a decimal string. `topE1rm` is rounded to one decimal as a VALUE (domain/Review.h); the text
// is not, because the writer renders the double at its own precision, so a value like `20.7` can
// reach a client as `20.699999999999999` and parse back to exactly the double the domain rounded.
// Clients parse and format: nothing prints the raw token, and nothing re-rounds or re-derives the
// estimate. Nothing gym owns decides that precision — it is one writer setting away, in the
// platform's HTTP and MCP edges, and it is the same for `weightKg`, `rpe` and the review's own
// estimate.
Json::Value toJson(const LogRow& row);
Json::Value toJson(const Set& set);
Json::Value toJson(const std::vector<Set>& sets);
Json::Value toJson(const Exercise& exercise);
Json::Value toJson(const std::vector<Exercise>& exercises);
// The picker's meta, one line per movement this lifter has trained and no line for any other — a
// movement with no row here is the `never logged` the picker draws, so nothing needs to be sent to
// say so. It rides BESIDE the catalog rather than on it (ARCHITECTURE §5): `exercise out` is read on
// nearly every screen and by `list_exercises`, whose reply a whole wave was spent shrinking.
Json::Value toJson(const std::vector<LastSet>& movements);
Json::Value toJson(const Routine& routine);
// The routine as every LIST and every single read hands it over: the plan, and the one proposal
// standing on it. The two travel together because every surface that draws a day of the program
// draws the dot beside it (§B5's `1 proposal`), and a second round trip per routine to learn that
// is the N+1 the log read already refused.
Json::Value toJson(const Routine& routine, const std::optional<ProposalHead>& pending);
Json::Value toJson(const std::vector<Routine>& routines, const std::vector<ProposalHead>& pending);
Json::Value toJson(const ProposalHead& head);
Json::Value toJson(const RoutineProposal& proposal);
Json::Value toJson(const std::vector<ProposalHead>& heads);
Json::Value toJson(const PlanSnapshot& plan);
// The settings document out, and it is the same shape parsePreferences reads in — a client PUTs
// back exactly what it was handed. `restSeconds` is the one omission, and it is the omission that
// means the timer is off; `platesKg` is always present, and an EMPTY array is a real answer meaning
// a gym with nothing to load onto the bar.
Json::Value toJson(const GymPreferences& preferences);
Json::Value toJson(const Review& review);
// The other two one-way shapes, for the same reason the review is one: every number in them is
// computed or read on each call and there is nothing for a client to send back. The share's is
// deliberately NOT `toJson(const Session&)` — that one carries the ids and the frozen plan, and a
// reader who is not the owner gets neither (ports/TrainingRepository.h says why).
Json::Value toJson(const Statistics& statistics);
Json::Value toJson(const MovementRecord& record);
Json::Value toJson(const SharedSession& shared);
std::optional<PlanSnapshot> planFrom(const Json::Value& stored);   // clamps, never throws

// The one place a share token becomes a link, because it has been three places and they disagreed:
// the web composed the page's own hash route while the phone and the MCP tool each pasted the JSON
// route onto a base url, so a lifter who shared from either handed their coach a page of JSON. It
// takes the APP's base url — where the browser app is served — not the API's. In production one
// origin answers both, which is exactly why the wrong one went unnoticed. The server composes it
// once and every surface renders what it is given.
std::string shareUrl(const std::string& appBaseUrl, const std::string& token);
// Where a lifter opens the diff and taps. It rides in every mint's receipt, because a receipt that
// said a proposal was waiting and did not say where would leave an agent inventing a url or telling
// its human to go and look.
std::string proposalUrl(const std::string& appBaseUrl, const ProposalId& id);

}
