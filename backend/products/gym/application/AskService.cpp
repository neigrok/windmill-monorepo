#include "products/gym/application/AskService.h"
#include "platform/application/WriteObservation.h"
#include "platform/domain/sync/Digest.h"

#include "products/gym/adapters/mcp/GymToolCatalog.h"
#include "products/gym/adapters/json/GymJson.h"

#include <trantor/utils/Logger.h>
#include <drogon/utils/Utilities.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <new>
#include <optional>
#include <utility>

namespace wm::gym {

namespace {

// The server Coach answers only while no workout is open (AskRefusal::sessionOpen), so a change to the open
// workout is never its to propose: that tool is the phone Coach's and MCP's.
bool askOffers(const std::string& name) { return name != "propose_workout_change"; }

// The properties a tool publishes, comma-joined, for a refusal message.
std::string declaredArguments(const Json::Value& inputSchema) {
  std::string declared;
  for (const std::string& property : inputSchema["properties"].getMemberNames()) {
    if (!declared.empty()) declared += ", ";
    declared += property;
  }
  return declared.empty() ? "no arguments" : declared;
}

// Every gym tool publishes `additionalProperties: false`. Ask does not pass through
// CompositeToolHost, so the check is repeated here word for word and refuses identically.
std::optional<std::string> unknownArgument(const Json::Value& inputSchema,
                                           const Json::Value& arguments) {
  if (!arguments.isObject()) return std::nullopt;  // the host answers a wrong-shape body, naming its type
  const Json::Value& properties = inputSchema["properties"];
  for (const std::string& key : arguments.getMemberNames()) {
    if (properties.isMember(key)) continue;
    return "unknown argument \"" + key + "\". This tool takes: " + declaredArguments(inputSchema) + ".";
  }
  return std::nullopt;
}

const char* askOutcome(AskRefusal refusal) {
  switch (refusal) {
    case AskRefusal::none: return "ok";
    case AskRefusal::threadMalformed:
    case AskRefusal::questionEmpty:
    case AskRefusal::questionTooLong:
    case AskRefusal::questionUnstorable: return "http_400";
    case AskRefusal::threadTaken: return "ask-thread-taken";
    case AskRefusal::requestMalformed: return "ask-request-malformed";
    case AskRefusal::requestConflict: return "ask-request-conflict";
    case AskRefusal::generationActive: return "ask-generation-active";
    case AskRefusal::busy: return "ask-busy";
    case AskRefusal::attachmentInvalid: return "ask-attachment-invalid";
    case AskRefusal::notConfigured: return "ask-not-configured";
    case AskRefusal::sessionOpen: return "ask-session-open";
    case AskRefusal::dailyLimit: return "ask-daily-limit";
    case AskRefusal::outOfBudget: return "ask-out-of-budget";
    case AskRefusal::aiBudget: return "ai-budget-unavailable";
    case AskRefusal::aiAccountingUnavailable: return "ai_accounting_unavailable";
  }
  return "refused";
}

// How long a confirmation waits for another confirmation of the same conversation to finish.
constexpr std::chrono::milliseconds kConfirmLeaseWait{3000};

// A question refills every kMsPerQuestion; after kRefilledMs idle any bucket is full whatever it
// held, so it can be forgotten.
constexpr double kMsPerQuestion = 86'400'000.0 / kAskPerDay;
constexpr double kRefilledMs = kAskBackToBack * kMsPerQuestion;
constexpr std::size_t kMaxAccountsHeld = 100000;

// Milliseconds between two readings of the wall clock; one that stepped back refilled nothing.
double msBetween(std::uint64_t earlierMs, std::uint64_t laterMs) {
  return laterMs > earlierMs ? static_cast<double>(laterMs - earlierMs) : 0.0;
}

}  // namespace

AskRation::Take AskRation::take(const std::string& account, std::uint64_t nowMs) {
  std::lock_guard<std::mutex> holding(mutex_);
  if (held_.size() > kMaxAccountsHeld) {
    for (auto entry = held_.begin(); entry != held_.end();) {
      if (msBetween(entry->second.refilledAtMs, nowMs) >= kRefilledMs)
        entry = held_.erase(entry);
      else
        ++entry;
    }
  }

  Held& ration = held_[account];
  ration.questions = std::min(kAskBackToBack,
                              ration.questions + msBetween(ration.refilledAtMs, nowMs) / kMsPerQuestion);
  ration.refilledAtMs = nowMs;
  if (ration.questions >= 1.0) {
    ration.questions -= 1.0;
    return {true, {}};
  }
  const auto afterMs = static_cast<std::uint64_t>(std::ceil((1.0 - ration.questions) * kMsPerQuestion));
  return {false, {nowMs + afterMs, afterMs}};
}

void AskRation::giveBack(const std::string& account) {
  std::lock_guard<std::mutex> holding(mutex_);
  const auto ration = held_.find(account);
  if (ration == held_.end()) return;
  ration->second.questions = std::min(kAskBackToBack, ration->second.questions + 1.0);
}

AskTools::AskTools(GymTools& inner, ThreadId thread, AskThreadRepository* repository,
                   AskGeneration* generation)
    : inner_(inner), repository_(repository), generation_(generation), thread_(std::move(thread)) {}

void AskTools::observe(const ToolResult& result, const std::string& name, const std::string& operationId) {
  if (result.isError) return;
  if (result.payload["proposal"]["id"].isString()) {
    const auto id = result.payload["proposal"]["id"].asString();
    if (std::find(proposals_.begin(), proposals_.end(), id) == proposals_.end()) proposals_.push_back(id);
  }
  if (name != "create_routine" || !generation_) return;
  if (result.payload["confirmationRequired"].asBool()) {
    auto& drafts = generation_->routineDrafts;
    if (std::any_of(drafts.begin(), drafts.end(), [&](const auto& draft) { return draft.operationId == operationId; })) return;
    const auto routine = parseRoutineWrite(result.payload);
    drafts.push_back({operationId, routine.id.str(), routine.name, routine.position, routine.entries});
    return;
  }
  auto& results = generation_->results;
  if (std::any_of(results.begin(), results.end(), [&](const auto& held) { return held.operationId == operationId; })) return;
  results.push_back({operationId, result.payload["id"].asString(), result.payload["name"].asString()});
  if (result.payload["entries"].isArray()) results.back().movementCount = result.payload["entries"].size();
}

bool AskTools::writes(const std::string& name) const {
  if (!repository_) return false;
  if (name == "create_routine") return generation_->routineReview;
  return name == "save_note" || name == "update_exercise";
}

ToolResult AskTools::draftRoutine(const Json::Value& document, const ToolCaller& caller) {
  const auto routine = parseRoutineWrite(document);
  const auto catalog = inner_.callTool("list_exercises", Json::Value(Json::objectValue), caller);
  if (catalog.isError) return catalog;
  const auto& exercises = catalog.payload["exercises"];
  for (const auto& entry : routine.entries)
    if (std::none_of(exercises.begin(), exercises.end(), [&](const auto& exercise) { return exercise["id"].asString() == entry.exercise.str(); }))
      return ToolResult::failure("a routine draft names an unknown exercise; read list_exercises first");
  auto draft = document;
  draft["confirmationRequired"] = true;
  return ToolResult::json(draft);
}

void AskTools::recover(const ToolCaller& caller, bool allowWrite) {
  if (!repository_) return;
  operations_ = repository_->operations(caller.user, thread_, generation_->id);
  if (operations_.empty()) return;
  for (auto& operation : operations_) {
    if (!operation.result) {
      operation.result = inner_.completedAction(caller.user, operation.name,
        operation.arguments[operation.name == "update_exercise" ? "requestId" : "id"].asString());
      if (!operation.result && operation.name == "create_routine") operation.result = draftRoutine(operation.arguments, caller);
      if (!operation.result && !allowWrite) continue;
      if (operation.result) repository_->saveOperation(caller.user, thread_, generation_->id, operation);
    }
    if (!operation.result) {
      const auto declarations = inner_.declareTools();
      const auto declared = std::find_if(declarations.begin(), declarations.end(), [&](const auto& tool) {
        return tool.name() == operation.name && tool.access != Access::read;
      });
      const std::string operationName = declared == declarations.end() ? "gym.coach.recover" :
          "gym." + declared->name();
      WriteObservation observation{operationName, "gym", "Coach"};
      WriteContext context{observation};
      try {
        operation.result = inner_.callTool(operation.name, operation.arguments, caller,
            ProposalSource{ProposalDoor::ask, "", "", thread_}, read_);
        observation.finish(toolWriteOutcome(*operation.result));
      } catch (const std::exception& error) {
        observation.fail(error);
        throw;
      } catch (...) {
        observation.failUnknown();
        throw;
      }
      repository_->saveOperation(caller.user, thread_, generation_->id, operation);
    }
    observe(*operation.result, operation.name, operation.id);
    steps_.push_back({operation.name, operation.result->isError});
  }
  repository_->saveGeneration(caller.user, thread_, *generation_);
}

std::vector<ToolDeclaration> AskTools::declareTools() const {
  std::vector<ToolDeclaration> offered;
  const bool setup = repository_ && generation_->purpose == "routine_setup";
  for (ToolDeclaration& declaration : inner_.declareTools()) {
    if (!askOffers(declaration.name())) continue;
    if (setup) {
      const auto name = declaration.name();
      if (name != "list_sessions" && name != "get_sessions" && name != "list_notes" &&
          name != "list_exercises" && name != "list_routines" && name != "save_note" &&
          name != "create_routine") continue;
    }
    if (declaration.access == Access::read || mintsProposal(declaration.name()) || writes(declaration.name())) {
      if (declaration.name() == "create_routine")
        declaration.descriptor["description"] = "Prepare a new routine for the lifter to review. This saves only a draft. No routine exists until the lifter taps Save routine. Use actual exercise IDs from list_exercises and read list_notes first. Explain the plan and ask the lifter to review it. Each routine needs a distinct stable id; replay exactly the same document.";
      offered.push_back(std::move(declaration));
    }
  }
  if (setup) {
    offered.push_back({parse(R"({
      "name":"ask_setup_details",
      "description":"Ask only for materially missing training days or equipment before routine setup. Use information already provided. Keep labels brief. For multiple equipment choices offer compatible items; ask about no equipment in plain text instead of mixing a none option with selectable equipment. Choices fill the lifter's editable draft and never perform an action. Ask once per answer, explain the question in prose, then wait for the lifter.",
      "inputSchema":{
        "type":"object", "additionalProperties":false, "required":["question","groups"],
        "properties":{
          "question":{"type":"string","minLength":1,"maxLength":500},
          "groups":{
            "type":"array", "minItems":1, "maxItems":2,
            "items":{
              "type":"object", "additionalProperties":false, "required":["id","label","multiple","options"],
              "properties":{
                "id":{"type":"string","enum":["days","equipment"]},
                "label":{"type":"string","minLength":1,"maxLength":80},
                "multiple":{"type":"boolean"},
                "options":{
                  "type":"array", "minItems":1, "maxItems":6,
                  "items":{
                    "type":"object", "additionalProperties":false, "required":["id","label"],
                    "properties":{
                      "id":{"type":"string","minLength":1,"maxLength":32,"pattern":"^[a-z0-9_-]+$"},
                      "label":{"type":"string","minLength":1,"maxLength":80}
                    }
                  }
                }
              }
            }
          }
        }
      }
    })"), "gym", Access::write});
  }
  return offered;
}

ToolResult AskTools::callTool(const std::string& name, const Json::Value& arguments,
                              const ToolCaller& caller) {
  const auto declarations = name == "ask_setup_details" ? declareTools() : inner_.declareTools();
  const auto declared = std::find_if(declarations.begin(), declarations.end(), [&](const auto& tool) {
    return tool.name() == name;
  });
  std::unique_ptr<WriteObservation> observation;
  std::unique_ptr<WriteContext> context;
  if (declared != declarations.end() && declared->access != Access::read) {
    observation = std::make_unique<WriteObservation>("gym." + declared->name(), "gym", "Coach");
    context = std::make_unique<WriteContext>(*observation);
  }
  try {
    const ToolResult result = [&]() {
      if (repository_) {
        const auto current = repository_->generation(caller.user, thread_, generation_->requestId);
        if (current && current->stopRequested) return ToolResult::failure("Coach was stopped before this action");
      }
      ToolResult outcome = dispatch(name, arguments, caller);
      steps_.push_back(AskStep{name, outcome.isError});
      return outcome;
    }();
    if (observation) observation->finish(toolWriteOutcome(result));
    return result;
  } catch (const std::exception& error) {
    if (observation) observation->fail(error);
    throw;
  } catch (...) {
    if (observation) observation->failUnknown();
    throw;
  }
}

ToolResult AskTools::dispatch(const std::string& name, const Json::Value& arguments,
                              const ToolCaller& caller) {
  std::optional<ToolDeclaration> declared;
  for (ToolDeclaration& candidate : name == "ask_setup_details" ? declareTools() : inner_.declareTools())
    if (candidate.name() == name) declared = std::move(candidate);

  if (!declared || !askOffers(name)) {
    // A name gym retired answers with what replaced it, on this door as over MCP.
    if (std::optional<ToolRetirement> retired = inner_.retirement(name))
      return ToolResult::failure(name + ": " + retired->sentence);
    return ToolResult::failure(name + ": no such tool — call tools/list for what Coach may do.");
  }
  if (name == "create_routine" && !writes(name))
    return ToolResult::failure(name + ": this version of the app cannot review routine drafts. Describe the routine in your answer "
                               "and tell the lifter to update the app or build it in Routines.");
  if (repository_ && generation_->purpose == "routine_setup") {
    const auto offered = declareTools();
    if (std::none_of(offered.begin(), offered.end(), [&](const auto& tool) { return tool.name() == name; }))
      return ToolResult::failure(name + ": not available during routine setup — use the declared setup tools.");
  }
  if (declared->access != Access::read && name != "ask_setup_details" && !mintsProposal(name) && !writes(name))
    // Asked FIRST, before the grant below, so a tool this door never offers answers the same at
    // every grant.
    return ToolResult::failure(name +
                               ": Coach reads the log and proposes; it cannot change what a lifter "
                               "logged. Tell them that one is theirs to change, and name the workout "
                               "and the movement so they can find it.");
  // The grant, checked where the CALL is and not only where the catalog is.
  if (!caller.scope.allows(declared->product, declared->access))
    return ToolResult::failure(name + ": this connection was not granted " + declared->product + ":" +
                               toString(declared->access) + ", so it cannot run this tool.");
  if (std::optional<std::string> unknown =
          unknownArgument(declared->descriptor["inputSchema"], arguments))
    return ToolResult::failure(name + ": " + *unknown);
  if (name == "ask_setup_details") {
    Json::Value body = arguments;
    if (!body.isObject()) return ToolResult::failure("setup details must be an object");
    body["id"] = "clarify_" + generation_->id;
    const auto clarification = clarificationFrom(body);
    if (!clarification) return ToolResult::failure("setup details require bounded days/equipment choices with unique ids");
    if (generation_->clarification && *generation_->clarification != *clarification)
      return ToolResult::failure("this answer already has different setup details; keep the original question");
    generation_->clarification = clarification;
    repository_->saveGeneration(caller.user, thread_, *generation_);
    return ToolResult::json(toJson(*clarification));
  }

  if (name == "update_exercise") {
    if (!arguments["exerciseId"].isString()) return ToolResult::failure("exerciseId must name an existing movement");
    if (std::none_of(steps_.begin(), steps_.end(), [](const auto& step) { return step.tool == "list_exercises" && !step.failed; }))
      return ToolResult::failure("read list_exercises before editing an existing exercise");
    const std::string id = sync::sha256("update_exercise:" + generation_->id + ":" + arguments["exerciseId"].asString()).hex();
    const auto held = std::find_if(operations_.begin(), operations_.end(), [&](const auto& operation) { return operation.id == id; });
    if (held != operations_.end()) {
      if (held->input != arguments) return ToolResult::failure("this answer already holds a different edit for that exercise");
      if (held->result) return *held->result;
    }
    auto input = arguments;
    input["requestId"] = id;
    CoachOperation edit{id, name, input, std::nullopt, arguments};
    repository_->saveOperation(caller.user, thread_, generation_->id, edit);
    edit.result = inner_.callTool(name, input, caller, ProposalSource{ProposalDoor::ask, "", "", thread_}, read_);
    repository_->saveOperation(caller.user, thread_, generation_->id, edit);
    if (held == operations_.end()) operations_.push_back(edit); else *held = edit;
    return *edit.result;
  }

  Json::Value input = arguments;
  const bool write = mintsProposal(name) || name == "create_routine" || name == "save_note";
  CoachOperation* operation = nullptr;
  if (write && repository_) {
    if (!arguments.isObject() || !arguments["id"].isString() || !wellFormedId(arguments["id"].asString()))
      return ToolResult::failure("a write requires a stable, well-formed id");
    const std::string key = name + ":" + arguments["id"].asString();
    const auto alias = callIds_.find(key);
    std::optional<std::size_t> routineSlot;
    std::size_t routine = 0;
    for (auto& held : operations_) {
      const auto index = routine;
      if (held.name == "create_routine") ++routine;
      const bool identity = alias != callIds_.end() ? held.id == alias->second :
          held.name == name && ((held.input.isObject() && held.input["id"] == arguments["id"]) || held.arguments["id"] == arguments["id"]);
      if (!identity) continue;
      operation = &held;
      if (name == "create_routine") routineSlot = index;
      break;
    }
    if (!operation) {
      routine = 0;
      for (auto& held : operations_) {
        if (name == "create_routine") {
          if (held.name != name || routine++ != routineIndex_) continue;
          routineSlot = routineIndex_;
        } else if (name == "save_note") {
          if (held.name != name) continue;
        } else if (!mintsProposal(held.name)) {
          continue;
        }
        operation = &held;
        break;
      }
    }
    if (operation) {
      Json::Value original = operation->input.isNull() ? operation->arguments : operation->input;
      Json::Value requested = arguments;
      original.removeMember("id");
      requested.removeMember("id");
      if (operation->name != name || original != requested)
        return ToolResult::failure("this action slot already has a different immutable document; replay its original arguments before continuing");
      if (routineSlot && *routineSlot > routineIndex_)
        return ToolResult::failure("replay earlier held routine actions before this action");
      callIds_[key] = operation->id;
      if (routineSlot && *routineSlot == routineIndex_) ++routineIndex_;
      if (operation->result) return *operation->result;
      input = operation->arguments;
    } else {
      if (name == "create_routine" && routineIndex_ >= kMaxCoachRoutineCreations)
        return ToolResult::failure("this answer has reached its six routine additions; ask the lifter before another answer");
      const std::vector<std::string> reads = name == "create_routine" ? std::vector<std::string>{"list_notes", "list_exercises"}
          : name == "save_note" ? std::vector<std::string>{"list_notes"} : std::vector<std::string>{};
      for (const auto& required : reads) {
        if (std::none_of(steps_.begin(), steps_.end(), [&](const AskStep& step) { return step.tool == required && !step.failed; }))
          return ToolResult::failure("read the lifter's notes before saving an insight, and the movement catalog before creating a routine");
      }
      try {
        if (name == "create_routine") {
          const auto routine = parseRoutineWrite(arguments);
          Routine{routine.id, caller.user, routine.name, routine.position, routine.entries};
        }
        if (name == "save_note") parseNoteWrite(arguments, NoteId{arguments["id"].asString()}, caller.user);
        if (mintsProposal(name)) {
          if (!arguments["routineId"].isString() || !wellFormedId(arguments["routineId"].asString()))
            throw InvalidTraining("a proposal requires a well-formed routine id");
          if (!arguments["summary"].isNull() && (!arguments["summary"].isString() ||
              arguments["summary"].asString().size() > kMaxSummaryLength || !storableText(arguments["summary"].asString())))
            throw InvalidTraining("a proposal summary must be bounded, storable text");
          if (name == "propose_routine_change") {
            const auto proposal = parseProposalWrite(arguments, ProposalSource{ProposalDoor::ask, "", "", thread_});
            Routine{proposal.routine, caller.user, proposal.name.value_or("Routine"), 0, proposal.entries};
          }
        }
      } catch (const InvalidTraining& error) {
        return ToolResult::failure(error.what());
      }
      const std::string slot = name == "save_note" ? "note_" : name == "create_routine" ? "create_" + std::to_string(routineIndex_) + "_" : "proposal_";
      input["id"] = name == "save_note" ? Json::Value("note_" + generation_->id) :
          name == "create_routine" ? Json::Value("rt_" + generation_->id + "_" + std::to_string(routineIndex_)) : arguments["id"];
      operations_.push_back({"op_" + slot + generation_->id, name, input, std::nullopt, arguments});
      operation = &operations_.back();
      repository_->saveOperation(caller.user, thread_, generation_->id, *operation);
      callIds_[key] = operation->id;
      if (name == "create_routine") ++routineIndex_;
    }
  } else if (mintsProposal(name) && !proposals_.empty()) {
    return ToolResult::failure(name + ": you already wrote a proposal this turn; fold both into one document");
  }
  const ToolResult outcome = name == "create_routine" && operation ? draftRoutine(input, caller)
      : inner_.callTool(name, input, caller, ProposalSource{ProposalDoor::ask, "", "", thread_}, read_);
  if (operation) {
    operation->result = outcome;
    repository_->saveOperation(caller.user, thread_, generation_->id, *operation);
  }
  observe(outcome, name, operation ? operation->id : "");
  if (write && repository_) repository_->saveGeneration(caller.user, thread_, *generation_);
  return outcome;
}

AskService::AskService(TrainingService& training, AskThreadRepository& threads, Clock& clock, AskAgent& agent,
                       GymTools& gymTools, Entitlements& entitlements,
                       std::shared_ptr<FailureReporter> failures)
    : training_(training), threads_(threads), clock_(clock), agent_(agent), gymTools_(gymTools),
      entitlements_(entitlements), failures_(std::move(failures)) {
  workers_.start();
  readers_.start();
  admissions_.start();
}

ConfirmReply AskService::confirmRoutine(const UserId& user, const ThreadId& thread, const std::string& requestId,
                                        const std::string& operationId) {
  if (!threads_.threadAvailable(user, thread)) return {ConfirmRefusal::draftNotFound};
  auto lease = threads_.tryLease(user, thread);
  if (!lease) {
    const auto held = threads_.generation(user, thread, requestId);
    if (!held) return {ConfirmRefusal::draftNotFound};
    if (held->status == "running") return {ConfirmRefusal::generationActive};
    lease = threads_.awaitLease(user, thread, kConfirmLeaseWait);
    if (!lease) return {ConfirmRefusal::saveInProgress};
  }
  auto generation = threads_.generation(user, thread, requestId);
  if (!generation) return {ConfirmRefusal::draftNotFound};
  if (generation->status == "running") return {ConfirmRefusal::generationActive};
  auto draft = std::find_if(generation->routineDrafts.begin(), generation->routineDrafts.end(),
                           [&](const auto& item) { return item.operationId == operationId; });
  if (draft == generation->routineDrafts.end()) return {ConfirmRefusal::draftNotFound};
  if (draft->state == "saved") return {ConfirmRefusal::none, generation};
  auto operations = threads_.operations(user, thread, generation->id);
  auto operation = std::find_if(operations.begin(), operations.end(),
                              [&](const auto& item) { return item.id == operationId && item.name == "create_routine"; });
  if (operation == operations.end()) throw std::logic_error("routine draft has no held document");
  ReadReceipt read;
  const ToolCaller caller{user, ToolScope({{"gym", Access::write}})};
  const auto result = gymTools_.callTool("create_routine", operation->arguments, caller,
                                      ProposalSource{ProposalDoor::ask, "", "", thread}, read);
  if (result.isError && result.outcomeCode.rfind("gym-engine-", 0) == 0)
    throw GymUnavailable{result.outcomeCode, "the routine could not be saved now; try again shortly"};
  if (result.isError && result.outcomeCode == "failed") throw std::runtime_error("routine draft save failed");
  if (result.isError) return {ConfirmRefusal::draftInvalid};
  operation->result = result;
  threads_.saveOperation(user, thread, generation->id, *operation);
  draft->state = "saved";
  if (std::none_of(generation->results.begin(), generation->results.end(), [&](const auto& item) { return item.operationId == operationId; }))
    generation->results.push_back({operationId, draft->routineId, draft->name, static_cast<unsigned>(draft->entries.size())});
  threads_.saveGeneration(user, thread, *generation, true);
  return {ConfirmRefusal::none, generation};
}

bool AskService::configured() const { return agent_.configured(); }

AskService::~AskService() { stop(); }

void AskService::stop() {
  std::call_once(stopped_, [this] {
    for (auto* loop : admissions_.getLoops()) loop->queueInLoop([loop] { loop->quit(); });
    admissions_.wait();
    for (auto* loop : workers_.getLoops()) loop->queueInLoop([loop] { loop->quit(); });
    workers_.wait();
    for (auto* loop : readers_.getLoops()) loop->queueInLoop([loop] { loop->quit(); });
    readers_.wait();
  });
}

void AskService::readGeneration(const UserId& user, const ThreadId& thread, const std::string& requestId,
                                std::function<void(bool, std::optional<AskGeneration>)> done) {
  readers_.getNextLoop()->queueInLoop([this, user, thread, requestId, done = std::move(done)] {
    std::optional<AskGeneration> generation;
    try { generation = threads_.generation(user, thread, requestId); }
    catch (const std::exception&) { done(false, std::nullopt); return; }
    done(true, generation);
  });
}

std::optional<AskGeneration> AskService::stop(const UserId& user, const ThreadId& thread, const std::string& requestId) {
  return observeWrite("ask.stop", "gym", "Coach", [&]() {
    auto generation = threads_.stopGeneration(user, thread, requestId);
    if (!generation || generation->status != "running") return generation;
    auto lease = threads_.tryLease(user, thread);
    if (!lease) return generation;
    generation = threads_.generation(user, thread, requestId);
    if (!generation || generation->status != "running") return generation;
    AskTools tools(gymTools_, thread, &threads_, &*generation);
    const ToolCaller caller{user, ToolScope({{"gym", Access::read}, {"gym", Access::write}})};
    tools.recover(caller, false);
    generation->status = "stopped";
    generation->stopRequested = true;
    if (!tools.steps().empty() || !tools.proposals().empty()) {
      if (!generation->receipt) generation->receipt = AnswerReceipt{};
      for (const auto& step : tools.steps()) {
        if (std::find(generation->steps.begin(), generation->steps.end(), step) == generation->steps.end())
          generation->steps.push_back(step);
        auto& steps = generation->receipt->steps;
        if (std::find(steps.begin(), steps.end(), step) == steps.end()) steps.push_back(step);
      }
      for (const auto& proposal : tools.proposals()) {
        auto& proposals = generation->receipt->proposals;
        if (std::find(proposals.begin(), proposals.end(), proposal) == proposals.end()) proposals.push_back(proposal);
      }
    }
    threads_.saveGeneration(user, thread, *generation);
    return generation;
  });
}

struct AskService::Job {
  UserId caller;
  std::string email;
  AskRequest request;
  std::function<void(AskReply)> done;
  AskReply reply;
  std::optional<AskGeneration> generation;
  std::unique_ptr<ThreadLease> lease;
  std::optional<std::size_t> worker;
  bool overlap = false;
  bool duplicate = false;
  bool charged = false;
  std::string where = "ask.setup";
  std::vector<CoachImage> images;
  ThreadOpenOutcome opened{std::nullopt, ThreadOpenError::none};
  std::shared_ptr<WriteObservation> observation;
};

void AskService::ask(const UserId& caller, const std::string& email, AskRequest request, std::function<void(AskReply)> done) {
  auto observation = std::make_shared<WriteObservation>("ask.run", "gym", "Coach", "", failures_.get());
  WriteContext context{*observation};
  done = [done = std::move(done), observation](AskReply reply) {
    observation->finish(reply.refusal == AskRefusal::aiBudget && reply.allowance
                        ? std::string(aiBudgetCodeName(reply.allowance->code)) :
                        reply.refusal != AskRefusal::none ? askOutcome(reply.refusal) :
                        !reply.answer.outcomeCode.empty() ? reply.answer.outcomeCode : reply.answer.ok || (reply.generation && reply.generation->status == "running") ? "ok" : "failed");
    done(std::move(reply));
  };
  if (!request.purpose.empty() && request.purpose != "conversation" && request.purpose != "routine_setup") { done(AskReply{AskRefusal::requestMalformed}); return; }
  if (!wellFormedId(request.thread.str())) { done(AskReply{AskRefusal::threadMalformed}); return; }
  if (!request.requestId.empty() && !wellFormedId(request.requestId)) { done(AskReply{AskRefusal::requestMalformed}); return; }
  if (request.attachmentIds.size() > 1 || std::any_of(request.attachmentIds.begin(), request.attachmentIds.end(), [](const auto& id) { return !wellFormedId(id); })) { done(AskReply{AskRefusal::attachmentInvalid}); return; }
  if (request.attachmentIds.empty() && request.question.find_first_not_of(" \t\r\n") == std::string::npos) { done(AskReply{AskRefusal::questionEmpty}); return; }
  if (request.question.size() > kMaxAskTurnBytes) { done(AskReply{AskRefusal::questionTooLong}); return; }
  if (!storableText(request.question)) { done(AskReply{AskRefusal::questionUnstorable}); return; }
  if (admissionCount_.fetch_add(1) >= 64) {
    --admissionCount_;
    done(AskReply{AskRefusal::busy});
    return;
  }
  if (request.requestId.empty()) request.requestId = drogon::utils::getUuid();
  auto job = std::make_shared<Job>(Job{caller, email, std::move(request), std::move(done)});
  job->observation = observation;
  const ThreadId& thread = job->request.thread;
  std::lock_guard lock(admissionMutex_);
  const auto active = active_.find(thread.str());
  if (active != active_.end()) {
    job->overlap = true;
    job->duplicate = active->second->caller == caller && active->second->request.requestId == job->request.requestId;
  } else {
    for (std::size_t index = 0; index < workerBusy_.size(); ++index) {
      if (workerBusy_[index]) continue;
      workerBusy_[index] = true;
      job->worker = index;
      active_[thread.str()] = job;
      break;
    }
  }
  // Admission is queued while holding the reservation lock, so a local duplicate cannot overtake it.
  admissions_.getNextLoop()->queueInLoop([this, job] {
    --admissionCount_;
    admit(job);
  });
}

void AskService::admit(const std::shared_ptr<Job>& job) {
  WriteContext context{*job->observation};
  const auto& caller = job->caller;
  const auto& email = job->email;
  const auto& thread = job->request.thread;
  const auto& question = job->request.question;
  const auto& requestId = job->request.requestId;
  const auto& attachmentIds = job->request.attachmentIds;
  const auto& purpose = job->request.purpose;
  auto& generation = job->generation;
  auto& reply = job->reply;
  auto& charged = job->charged;
  auto& images = job->images;
  auto& opened = job->opened;
  auto& repository = threads_;
  try {
    if (job->worker && !job->overlap) job->lease = repository.tryLease(caller, thread);
    generation = repository.generation(caller, thread, requestId);
    const auto replyFromStored = [&] {
      if (!generation) return false;
      std::vector<std::string> heldAttachments;
      for (const auto& attachment : generation->attachments) heldAttachments.push_back(attachment.id);
      if (generation->question != question || heldAttachments != attachmentIds || (!purpose.empty() && generation->purpose != purpose)) {
        reply.refusal = AskRefusal::requestConflict; finish(job); return true;
      }
      if (generation->status == "completed" || generation->status == "stopped") {
        reply.answer.ok = true; finish(job); return true;
      }
      return false;
    };
    if (replyFromStored()) return;
    if (!repository.threadAvailable(caller, thread)) {
      reply.refusal = AskRefusal::threadTaken; finish(job); return;
    }
    if (job->overlap) {
      if (!job->duplicate || !generation) reply.refusal = AskRefusal::generationActive;
      finish(job); return;
    }
    if (!job->worker) { reply.refusal = AskRefusal::busy; finish(job); return; }
    if (!job->lease) {
      // Re-read under the owner after the failed lease: another process may have just admitted this request.
      generation = repository.generation(caller, thread, requestId);
      if (replyFromStored()) return;
      if (!repository.threadAvailable(caller, thread)) reply.refusal = AskRefusal::threadTaken;
      else if (!generation || generation->status != "running") reply.refusal = AskRefusal::generationActive;
      finish(job); return;
    }
    if (!agent_.configured()) { reply.refusal = AskRefusal::notConfigured; finish(job); return; }
    if (training_.openSession(caller)) { reply.refusal = AskRefusal::sessionOpen; finish(job); return; }
    if (entitlements_.aiAllowancesEnabled()) {
      reply.allowance = entitlements_.aiAllowanceView(caller, email);
      if (reply.allowance->code != AiBudgetCode::Ok) {
        if (generation) {
          generation->status = "failed";
          generation->allowanceRefusal = reply.allowance;
          repository.saveGeneration(caller, thread, *generation);
        }
        reply.refusal = AskRefusal::aiBudget; finish(job); return;
      }
    } else if (!entitlements_.aiAllowanceFor(caller, email).allows()) {
      reply.refusal = AskRefusal::outOfBudget; finish(job); return;
    }

    for (const auto& id : attachmentIds) {
      auto image = repository.image(caller, thread, id);
      if (!image) { reply.refusal = AskRefusal::attachmentInvalid; finish(job); return; }
      images.push_back(std::move(*image));
    }
    opened = threads_.openThread(caller, thread, question.find_first_not_of(" \t\r\n") == std::string::npos ? "Photo" : question, clock_.nowMs());
    if (opened.error == ThreadOpenError::idTaken || !opened.thread) {
      reply.refusal = AskRefusal::threadTaken; finish(job); return;
    }
    if (!generation && opened.thread->generation && opened.thread->generation->status == "running") {
      reply.refusal = AskRefusal::generationActive; finish(job); return;
    }
    if (const auto ration = perAccount_.take(caller.str(), clock_.nowMs()); !ration.spent) {
      threads_.discardEmptyThread(caller, thread);
      reply.refusal = AskRefusal::dailyLimit; reply.nextQuestion = ration.next; finish(job); return;
    }
    charged = true;
    if (!generation) {
      generation = AskGeneration{drogon::utils::getUuid(), requestId, question};
      generation->purpose = purpose.empty() ? "conversation" : purpose;
      generation->routineReview = job->request.routineReview;
      generation->atMs = clock_.nowMs();
      for (const auto& image : images) generation->attachments.push_back(image.attachment);
    }
    generation->status = "running";
    generation->allowanceRefusal.reset();
    repository.saveGeneration(caller, thread, *generation);

    workers_.getLoop(*job->worker)->queueInLoop([this, job] { run(job); });
  } catch (const std::bad_alloc& error) { job->observation->reportFailure(error); throw; }
  catch (const std::exception& error) { fail(job, error); finish(job); }
  catch (...) {
    job->observation->reportUnknownFailure();
    fail(job, std::runtime_error("unknown Coach failure"));
    finish(job);
  }
}

void AskService::run(const std::shared_ptr<Job>& job) {
  WriteContext context{*job->observation};
  const auto& caller = job->caller;
  const auto& thread = job->request.thread;
  const auto& question = job->request.question;
  const auto& requestId = job->request.requestId;
  auto& generation = job->generation;
  auto& reply = job->reply;
  auto& charged = job->charged;
  auto& where = job->where;
  auto& images = job->images;
  auto& opened = job->opened;
  auto& repository = threads_;
  try {
    const ToolCaller actor{caller, ToolScope({{"gym", Access::read}, {"gym", Access::write}, {"gym", Access::del}})};
    if (const auto current = repository.generation(caller, thread, requestId)) generation = current;
    AskTools hands(gymTools_, thread, &repository, &*generation);
    where = "ask.recover";
    hands.recover(actor, !generation->stopRequested);
    std::vector<AskTurn> turns;
    const auto context = contextOf(opened.thread->turns);
    std::size_t imageCount = images.size();
    for (auto said = context.rbegin(); said != context.rend(); ++said) {
      AskTurn turn{said->fromLifter, said->text};
      for (const auto& attachment : said->attachments) {
        if (imageCount >= 3) { turn.text += "\n[An earlier photo is outside the current image context.]"; continue; }
        if (auto image = repository.image(caller, thread, attachment.id)) {
          turn.images.push_back({image->attachment.mediaType, std::move(image->data)});
          ++imageCount;
        }
      }
      turns.push_back(std::move(turn));
    }
    std::reverse(turns.begin(), turns.end());
    std::string current = question;
    for (const auto& operation : repository.operations(caller, thread, generation->id)) {
      if (operation.name != "create_routine") continue;
      current += "\n\nServer-held routine action for this request: " + dump(operation.input.isNull() ? operation.arguments : operation.input);
      if (operation.result) current += ". Original result: " + dump(operation.result->payload);
      current += ". Replay all held routine actions in this order with their exact documents before adding another. Their original receipts do not restore later edits or deletions.";
    }
    if (generation->clarification)
      current += "\n\nServer-held setup question for this request: " + dump(toJson(*generation->clarification)) + ". Keep these choices unchanged.";
    if (!hands.proposals().empty())
      current += "\n\nServer-observed proposal already exists for this request: " + hands.proposals().front() + ". Do not mint another.";
    for (const auto& operation : repository.operations(caller, thread, generation->id))
      if (operation.name == "save_note" && operation.result && !operation.result->isError)
        current += "\n\nServer-observed note save already completed for this request: " + dump(operation.result->payload) +
                   ". This is the original save receipt, not a claim that a later user edit or deletion was reversed. Do not save it again.";
    turns.push_back({true, current.empty() ? "Please help me with this photo." : current});
    for (auto& image : images) turns.back().images.push_back({image.attachment.mediaType, std::move(image.data)});
    bool stopped = generation->stopRequested;
    auto stopCheck = std::chrono::steady_clock::time_point{};
    auto lastSave = std::chrono::steady_clock::time_point{};
    AskControl control;
    control.continueRun = [&] {
      const auto now = std::chrono::steady_clock::now();
      if (now - stopCheck > std::chrono::milliseconds(100)) {
        const auto held = repository.generation(caller, thread, requestId);
        stopped = stopped || (held && held->stopRequested);
        stopCheck = now;
      }
      return !stopped;
    };
    control.text = [&](const std::string& text) {
      generation->answer = text;
      const auto now = std::chrono::steady_clock::now();
      if (now - lastSave < std::chrono::milliseconds(100)) return;
      generation->steps = hands.steps();
      repository.saveGeneration(caller, thread, *generation);
      lastSave = now;
    };
    where = "ask.run";
    try { reply.answer = agent_.answer(turns, actor, hands, control); }
    catch (const std::bad_alloc& error) { job->observation->reportFailure(error); throw; }
    catch (const std::exception& error) {
      reply.answer.error = "Coach failed at ask.run";
      job->observation->reportFailure(error);
    } catch (...) {
      reply.answer.error = "Coach failed at ask.run";
      job->observation->reportUnknownFailure();
    }
    if (reply.answer.modelTurns == 0) { perAccount_.giveBack(caller.str()); charged = false; }
    if (entitlements_.aiAllowancesEnabled()) {
      if (reply.answer.outcomeCode == "ai_accounting_unavailable")
        reply.refusal = AskRefusal::aiAccountingUnavailable;
      for (const auto code : {AiBudgetCode::FreeMonthExhausted, AiBudgetCode::FreeDayExhausted,
                              AiBudgetCode::ConcurrencyExhausted, AiBudgetCode::FundingRequired, AiBudgetCode::DeviceBound,
                              AiBudgetCode::SubjectExhausted, AiBudgetCode::DebtOutstanding,
                              AiBudgetCode::Unconfigured}) {
        if (reply.answer.outcomeCode != aiBudgetCodeName(code)) continue;
        reply.allowance = entitlements_.aiAllowanceView(caller, job->email);
        reply.allowance->code = code;
        reply.allowance->budgetResetsAtMs.reset();
        if (code == AiBudgetCode::FreeDayExhausted)
          reply.allowance->budgetResetsAtMs = AiBudgetPeriod::dayAt(clock_.nowMs())->endMs;
        if (code == AiBudgetCode::FreeMonthExhausted)
          reply.allowance->budgetResetsAtMs = AiBudgetPeriod::at(clock_.nowMs())->endMs;
        if (code == AiBudgetCode::SubjectExhausted)
          reply.allowance->budgetResetsAtMs = reply.allowance->resetsAtMs;
        reply.refusal = AskRefusal::aiBudget;
        break;
      }
    }
    const auto last = repository.generation(caller, thread, requestId);
    stopped = stopped || (last && last->stopRequested);
    generation->stopRequested = stopped;
    generation->status = stopped ? "stopped" : reply.answer.ok ? "completed" : "failed";
    if (reply.refusal == AskRefusal::aiBudget) generation->allowanceRefusal = reply.allowance;
    if (reply.answer.ok || !reply.answer.answer.empty()) generation->answer = reply.answer.answer;
    if (stopped) reply.answer.ok = true;
    generation->steps = reply.answer.steps;
    generation->receipt = AnswerReceipt{1, hands.read().tally(), hands.steps(), hands.proposals(), hands.read().observations()};
    where = "ask.persist";
    repository.saveGeneration(caller, thread, *generation);

  } catch (const std::bad_alloc& error) { job->observation->reportFailure(error); throw; }
  catch (const std::exception& error) { fail(job, error); }
  catch (...) {
    job->observation->reportUnknownFailure();
    fail(job, std::runtime_error("unknown Coach failure"));
  }
  finish(job);
}

void AskService::fail(const std::shared_ptr<Job>& job, const std::exception& error) {
  job->observation->reportFailure(error);
  if (job->charged && job->reply.answer.modelTurns == 0) perAccount_.giveBack(job->caller.str());
  job->reply.answer.ok = false;
  job->reply.answer.error = "Coach failed at " + job->where;
  if (job->generation) {
    job->generation->status = "failed";
    try { threads_.saveGeneration(job->caller, job->request.thread, *job->generation); } catch (const std::exception&) {}
  }

}

void AskService::finish(const std::shared_ptr<Job>& job) {
  if (job->generation) {
    job->reply.generation = job->generation;
    job->reply.answer.answer = job->generation->answer;
    job->reply.answer.steps = job->generation->steps;
    job->reply.receipt = job->generation->receipt;
    if (job->generation->receipt) {
      job->reply.read = job->generation->receipt->read;
      job->reply.proposals = job->generation->receipt->proposals;
    }
  }
  // Release database exclusion before making the worker available or publishing completion.
  job->lease.reset();
  if (job->worker) {
    std::lock_guard lock(admissionMutex_);
    workerBusy_[*job->worker] = false;
    active_.erase(job->request.thread.str());
    job->worker.reset();
  }
  auto done = std::move(job->done);
  if (done) done(std::move(job->reply));
}

}
