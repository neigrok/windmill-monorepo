#pragma once

#include "products/gym/ports/GymWriteDoor.h"
#include "products/gym/ports/ProgramRepository.h"
#include "products/gym/application/TrainingService.h"
#include "products/gym/domain/Bodyweight.h"
#include "products/gym/domain/Note.h"
#include "products/gym/domain/Preferences.h"
#include "products/gym/domain/ReadReceipt.h"
#include "products/gym/domain/Thread.h"

#include <json/value.h>

#include <cstdint>
#include <optional>
#include <vector>

namespace wm::gym {

// REST/MCP arguments, read replies and stored JSON; sync records follow gym.registry.json.

SessionStart parseSessionStart(const Json::Value& body);   // throws InvalidTraining
SetWrite parseSetWrite(const Json::Value& body);           // throws InvalidTraining
std::uint64_t parseFinish(const Json::Value& body);        // { "finishedAt": ms }; throws InvalidTraining
// Unknown fields are refused at both levels; each set is otherwise read as parseSetWrite reads it.
SessionImport parseSessionImport(const Json::Value& body); // throws InvalidTraining
RoutineWrite parseRoutineWrite(const Json::Value& body);   // throws InvalidTraining
// `position` is not a field here.
ProposalWrite parseProposalWrite(const Json::Value& body, const ProposalSource& source);
ExerciseWrite parseExerciseWrite(const Json::Value& body); // throws InvalidTraining
// The id and the owner are the caller's; the entity applies the three bounds.
Note parseNoteWrite(const Json::Value& body, const NoteId& id, const UserId& user);  // throws InvalidTraining

Json::Value toJson(const Session& session);
// `topE1rm` is the best estimate over every working set; `topSet` is only the heaviest, and no e1RM
// may be computed from it. `topE1rm` is rounded as a value, so 20.7 can reach a client as
// 20.699999999999999: clients format and never re-round.
Json::Value toJson(const LogRow& row);
Json::Value toJson(const Set& set);
Json::Value toJson(const std::vector<Set>& sets);
Json::Value toJson(const Exercise& exercise);
Json::Value toJson(const std::vector<Exercise>& exercises);
// One line per movement this lifter has trained; a movement with no row has never been logged.
Json::Value toJson(const std::vector<LastSet>& movements);
Json::Value toJson(const Routine& routine);
Json::Value toJson(const Routine& routine, const std::optional<ProposalHead>& pending);
Json::Value toJson(const std::vector<Routine>& routines, const std::vector<ProposalHead>& pending);
Json::Value toJson(const ProposalHead& head);
Json::Value toJson(const RoutineProposal& proposal);
Json::Value toJson(const std::vector<ProposalHead>& heads);
Json::Value toJson(const ThreadOutcome& outcome);
Json::Value toJson(const std::vector<CoachResult>& results);
std::vector<CoachResult> coachResultsFrom(const Json::Value& results);
Json::Value toJson(const CoachAttachment& attachment);
std::vector<CoachAttachment> coachAttachmentsFrom(const Json::Value& attachments);
Json::Value toJson(const AskGeneration& generation);
AskGeneration generationFrom(const Json::Value& body);
Json::Value toJson(const AskThread& thread);
Json::Value toJson(const std::vector<AskThread>& threads);
// Composed onto the single-routine read by the handler; the list read must not carry it.
Json::Value toJson(const std::vector<RoutineEvent>& history);
Json::Value toJson(const PlanSnapshot& plan);
// The `sets` array alone — the shape a proposal side stores as jsonb and every entry carries.
Json::Value toJson(const std::vector<SetTarget>& sets);
// An omitted `restSeconds` means the timer is off.
Json::Value toJson(const GymPreferences& preferences);
Json::Value toJson(const Note& note);
Json::Value toJson(const std::vector<Note>& notes);   // the array; the handler wraps it
Json::Value toJson(const Bodyweight& entry);
Json::Value toJson(const std::vector<Bodyweight>& entries);   // the array; the handler wraps it
Json::Value toJson(const Review& review);
Json::Value toJson(const Statistics& statistics);
Json::Value toJson(const StatsProgress& progress);
Json::Value toJson(const MovementRecord& record);
// The share omits the ids and the frozen plan: a reader who is not the owner gets neither.
Json::Value toJson(const SharedSession& shared);
Json::Value toJson(const HistoryWorkout& workout);
Json::Value toJson(const HistoryPage& page);
Json::Value toJson(const LogShare& share);
HistoryWorkout historyWorkoutFrom(const Json::Value& value);
Json::Value toJson(const ReadTally& tally);
Json::Value toJson(const std::vector<AskStep>& steps);
Json::Value toJson(const AnswerReceipt& receipt);
std::optional<AnswerReceipt> receiptFrom(const Json::Value& stored);
std::optional<PlanSnapshot> planFrom(const Json::Value& stored);   // clamps, never throws
// A stored `sets` array read back: anything that is not an array is the open line, and a set that
// cannot be read is dropped rather than failing the row it sits on.
std::vector<SetTarget> setTargetsFrom(const Json::Value& stored);   // clamps, never throws

// Takes the app's base url — where the browser app is served — not the API's.
std::string shareUrl(const std::string& appBaseUrl, const std::string& token);
std::string proposalUrl(const std::string& appBaseUrl, const ProposalId& id);

}
