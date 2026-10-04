#include "products/gym/application/AskService.h"
#include "products/gym/application/GymSwitches.h"
#include "platform/application/WriteObservation.h"

#include "products/gym/adapters/mcp/GymToolCatalog.h"

#include <trantor/utils/Logger.h>
#include <drogon/utils/Utilities.h>

#include <algorithm>
#include <cstddef>
#include <exception>
#include <new>
#include <optional>
#include <utility>

namespace wm::gym {

namespace {

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
    case AskRefusal::frozen: return "gym-frozen";
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
  }
  return "refused";
}

// After this long idle any bucket is full whatever it held, so it can be forgotten.
constexpr double kQuestionsPerSecond = kAskPerDay / 86400.0;
constexpr double kRefilledSeconds = kAskBackToBack / kQuestionsPerSecond;
constexpr std::size_t kMaxAccountsHeld = 100000;

}  // namespace

bool AskRation::take(const std::string& account) {
  const std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> holding(mutex_);
  if (held_.size() > kMaxAccountsHeld) {
    for (auto entry = held_.begin(); entry != held_.end();) {
      const double idle = std::chrono::duration<double>(now - entry->second.refilledAt).count();
      if (idle >= kRefilledSeconds)
        entry = held_.erase(entry);
      else
        ++entry;
    }
  }

  Held& ration = held_[account];
  if (ration.refilledAt != std::chrono::steady_clock::time_point{}) {
    const double elapsed = std::chrono::duration<double>(now - ration.refilledAt).count();
    ration.questions = std::min(kAskBackToBack, ration.questions + elapsed * kQuestionsPerSecond);
  }
  ration.refilledAt = now;
  if (ration.questions < 1.0) return false;
  ration.questions -= 1.0;
  return true;
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
  if (name == "create_routine" && generation_ && generation_->results.empty())
    generation_->results.push_back({operationId, result.payload["id"].asString(), result.payload["name"].asString()});
}

void AskTools::recover(const ToolCaller& caller, bool allowWrite) {
  if (gymWriteFrozen()) return;
  if (!repository_) return;
  operations_ = repository_->operations(caller.user, thread_, generation_->id);
  if (operations_.empty()) return;
  for (auto& operation : operations_) {
    if (!operation.result && !allowWrite) {
      operation.result = inner_.completedAction(caller.user, operation.name, operation.arguments["id"].asString());
      if (!operation.result) continue;
      repository_->saveOperation(caller.user, thread_, generation_->id, operation);
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
    if (operation.name == "save_note") steps_.push_back({operation.name, operation.result->isError});
  }
  repository_->saveGeneration(caller.user, thread_, *generation_);
}

std::vector<ToolDeclaration> AskTools::declareTools() const {
  std::vector<ToolDeclaration> offered;
  for (ToolDeclaration& declaration : inner_.declareTools())
    if (declaration.access == Access::read || mintsProposal(declaration.name()) ||
        (repository_ && (declaration.name() == "create_routine" || declaration.name() == "save_note")))
      offered.push_back(std::move(declaration));
  return offered;
}

ToolResult AskTools::callTool(const std::string& name, const Json::Value& arguments,
                              const ToolCaller& caller) {
  const auto declarations = inner_.declareTools();
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
      if (gymWriteFrozen())
        for (const auto& tool : declarations)
          if (tool.name() == name && tool.access != Access::read)
            return ToolResult::failure(name + ": gym-frozen: gym writes are temporarily frozen", "gym-frozen");
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
  for (ToolDeclaration& candidate : inner_.declareTools())
    if (candidate.name() == name) declared = std::move(candidate);

  if (!declared) {
    // A name gym retired answers with what replaced it, on this door as over MCP.
    if (std::optional<ToolRetirement> retired = inner_.retirement(name))
      return ToolResult::failure(name + ": " + retired->sentence);
    return ToolResult::failure(name + ": no such tool — call tools/list for what Coach may do.");
  }
  if (declared->access != Access::read && !mintsProposal(name) &&
      !(repository_ && (name == "create_routine" || name == "save_note")))
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
  // One proposal per turn, judged off `mintsProposal` and off what this run already minted — never
  // off a list of names. A second mint on the same routine would supersede the first before the
  // model's answer even named it, so the refusal lands BEFORE the inner call, in a sentence the
  // model can act on.
  if (mintsProposal(name) && !proposals_.empty())
    return ToolResult::failure(name + ": you already wrote a proposal this turn; fold both into "
                                      "one document");

  Json::Value input = arguments;
  const bool write = mintsProposal(name) || name == "create_routine" || name == "save_note";
  CoachOperation* operation = nullptr;
  if (write && repository_) {
    const auto held = std::find_if(operations_.begin(), operations_.end(), [&](const CoachOperation& candidate) {
      return (candidate.name == "save_note") == (name == "save_note");
    });
    if (held != operations_.end()) {
      if (held->name != name)
        return ToolResult::failure("this turn already has a routine action; finish that action before starting another");
      if (held->result && !held->result->isError) return *held->result;
      operation = &*held;
    }
    const std::vector<std::string> reads = name == "create_routine" ? std::vector<std::string>{"list_notes", "list_exercises"}
        : name == "save_note" ? std::vector<std::string>{"list_notes"} : std::vector<std::string>{};
    for (const auto& required : reads) {
      if (std::none_of(steps_.begin(), steps_.end(), [&](const AskStep& step) {
            return step.tool == required && !step.failed;
          }))
        return ToolResult::failure("read the lifter's notes before saving an insight, and the movement catalog before creating a routine");
    }
    input["id"] = operation ? operation->arguments["id"] : name == "save_note" ? Json::Value("note_" + generation_->id) :
        name == "create_routine" ? Json::Value("rt_" + generation_->id) : arguments["id"];
    if (!operation) {
      operations_.push_back({(name == "save_note" ? "op_note_" : "op_") + generation_->id, name, input});
      operation = &operations_.back();
    }
    operation->arguments = input;
    operation->result.reset();
    repository_->saveOperation(caller.user, thread_, generation_->id, *operation);
  }
  const ToolResult outcome = inner_.callTool(
      name, input, caller, ProposalSource{ProposalDoor::ask, "", "", thread_}, read_);
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
  if (gymWriteFrozen()) {
    WriteObservation observation{"ask.stop", "gym", "Coach"};
    observation.finish("gym-frozen");
    requireGymWrite();
  }
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
  ThreadId thread;
  std::string question;
  std::string requestId;
  std::vector<std::string> attachmentIds;
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

void AskService::ask(const UserId& caller, const std::string& email, const ThreadId& thread,
                     std::string question, std::function<void(AskReply)> done, std::string requestId, std::vector<std::string> attachmentIds) {
  auto observation = std::make_shared<WriteObservation>("ask.run", "gym", "Coach", "", failures_.get());
  WriteContext context{*observation};
  done = [done = std::move(done), observation](AskReply reply) {
    observation->finish(reply.refusal != AskRefusal::none ? askOutcome(reply.refusal) :
                        !reply.answer.outcomeCode.empty() ? reply.answer.outcomeCode : reply.answer.ok || (reply.generation && reply.generation->status == "running") ? "ok" : "failed");
    done(std::move(reply));
  };
  if (gymWriteFrozen()) { done(AskReply{AskRefusal::frozen}); return; }
  if (!wellFormedId(thread.str())) { done(AskReply{AskRefusal::threadMalformed}); return; }
  if (!requestId.empty() && !wellFormedId(requestId)) { done(AskReply{AskRefusal::requestMalformed}); return; }
  if (attachmentIds.size() > 1 || std::any_of(attachmentIds.begin(), attachmentIds.end(), [](const auto& id) { return !wellFormedId(id); })) { done(AskReply{AskRefusal::attachmentInvalid}); return; }
  if (attachmentIds.empty() && question.find_first_not_of(" \t\r\n") == std::string::npos) { done(AskReply{AskRefusal::questionEmpty}); return; }
  if (question.size() > kMaxAskTurnBytes) { done(AskReply{AskRefusal::questionTooLong}); return; }
  if (!storableText(question)) { done(AskReply{AskRefusal::questionUnstorable}); return; }
  if (admissionCount_.fetch_add(1) >= 64) {
    --admissionCount_;
    done(AskReply{AskRefusal::busy});
    return;
  }
  if (requestId.empty()) requestId = drogon::utils::getUuid();
  auto job = std::make_shared<Job>(Job{caller, email, thread, std::move(question), std::move(requestId), std::move(attachmentIds), std::move(done)});
  job->observation = observation;
  std::lock_guard lock(admissionMutex_);
  const auto active = active_.find(thread.str());
  if (active != active_.end()) {
    job->overlap = true;
    job->duplicate = active->second->caller == caller && active->second->requestId == job->requestId;
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
  const auto& thread = job->thread;
  const auto& question = job->question;
  const auto& requestId = job->requestId;
  const auto& attachmentIds = job->attachmentIds;
  auto& generation = job->generation;
  auto& reply = job->reply;
  auto& charged = job->charged;
  auto& images = job->images;
  auto& opened = job->opened;
  auto& repository = threads_;
  try {
    if (gymWriteFrozen()) { reply.refusal = AskRefusal::frozen; finish(job); return; }
    if (job->worker && !job->overlap) job->lease = repository.tryLease(caller, thread);
    generation = repository.generation(caller, thread, requestId);
    const auto replyFromStored = [&] {
      if (!generation) return false;
      std::vector<std::string> heldAttachments;
      for (const auto& attachment : generation->attachments) heldAttachments.push_back(attachment.id);
      if (generation->question != question || heldAttachments != attachmentIds) {
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
    if (!entitlements_.aiAllowanceFor(caller, email).allows()) {
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
    if (!perAccount_.take(caller.str())) {
      threads_.discardEmptyThread(caller, thread);
      reply.refusal = AskRefusal::dailyLimit; finish(job); return;
    }
    charged = true;
    if (!generation) {
      generation = AskGeneration{drogon::utils::getUuid(), requestId, question};
      generation->atMs = clock_.nowMs();
      for (const auto& image : images) generation->attachments.push_back(image.attachment);
    }
    generation->status = "running";
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
  const auto& thread = job->thread;
  const auto& question = job->question;
  const auto& requestId = job->requestId;
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
    if (!generation->results.empty()) {
      current += "\n\nServer-observed action already completed for this request: routine " + generation->results.front().routineId +
                 " was created. Do not create it again; report that result truthfully.";
    }
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
    const auto last = repository.generation(caller, thread, requestId);
    stopped = stopped || (last && last->stopRequested);
    generation->stopRequested = stopped;
    generation->status = stopped ? "stopped" : reply.answer.ok ? "completed" : "failed";
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
    try { threads_.saveGeneration(job->caller, job->thread, *job->generation); } catch (const std::exception&) {}
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
    active_.erase(job->thread.str());
    job->worker.reset();
  }
  auto done = std::move(job->done);
  if (done) done(std::move(job->reply));
}

}
