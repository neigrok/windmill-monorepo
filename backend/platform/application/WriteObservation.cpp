#include "platform/application/WriteObservation.h"

#include <json/json.h>
#include <trantor/utils/Logger.h>

#include <atomic>
#include <cmath>
#include <mutex>
#include <random>
#include <typeinfo>

namespace wm {

struct WriteRequestState {
  std::string id;
  std::atomic<bool> reported{false};
  std::atomic<std::uint64_t> nextObservation{0};
  std::atomic<std::uint64_t> infoOwner{0};
  std::atomic<std::uint64_t> transportOwner{0};
  std::atomic<bool> infoEmitted{false};
  std::atomic<std::uint64_t> writes{0};
};

namespace {
thread_local std::shared_ptr<WriteRequestState> current;
thread_local WriteObservation* currentObservation = nullptr;
std::mutex configurationMutex;
std::shared_ptr<FailureReporter> installedReporter;
std::function<void(const WriteCompletion&)> installedSink;

std::string newRequestId() {
  static thread_local std::mt19937_64 random{std::random_device{}()};
  constexpr char digits[] = "0123456789abcdef";
  std::string id(32, '0');
  for (char& c : id) c = digits[random() & 15];
  return id;
}

std::shared_ptr<WriteRequestState> requestState(const std::string& id) {
  if (current && (id.empty() || id == current->id)) return current;
  auto state = std::make_shared<WriteRequestState>();
  state->id = id.empty() ? newRequestId() : id;
  return state;
}
}

void installWriteReporter(std::shared_ptr<FailureReporter> reporter) {
  std::lock_guard lock(configurationMutex);
  installedReporter = std::move(reporter);
}

void installWriteSink(std::function<void(const WriteCompletion&)> sink) {
  std::lock_guard lock(configurationMutex);
  installedSink = std::move(sink);
}

std::string writeCompletionJson(const WriteCompletion& completion) {
  Json::Value fields(Json::objectValue);
  fields["operation"] = completion.operation;
  fields["product"] = completion.product;
  fields["door"] = completion.door;
  fields["outcome"] = completion.outcome;
  fields["duration_ms"] = completion.durationMs;
  fields["request_id"] = completion.requestId;
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  builder["precisionType"] = "decimal";
  builder["precision"] = 2;
  return Json::writeString(builder, fields);
}

std::string writeRequestId() { return current ? current->id : newRequestId(); }
std::string currentWriteRequestId() { return current ? current->id : std::string{}; }
bool claimWriteIssue() { return !current || !current->reported.exchange(true); }
void reportCurrentWriteFailure(const std::exception& error) {
  if (currentObservation) currentObservation->reportFailure(error);
}
void reportCurrentUnknownWriteFailure() {
  if (currentObservation) currentObservation->reportUnknownFailure();
}
void finishCurrentWriteRefusal(const std::string& code) {
  if (currentObservation) currentObservation->finish(code);
}
void markCurrentWrite() {
  if (current) ++current->writes;
}

WriteContext::WriteContext(const std::string& requestId)
    : previous_(current), previousObservation_(currentObservation) {
  current = requestState(requestId);
  currentObservation = nullptr;
}

WriteContext::WriteContext(WriteObservation& observation)
    : previous_(current), previousObservation_(currentObservation) {
  current = observation.state_;
  currentObservation = &observation;
}

WriteContext::~WriteContext() {
  current = std::move(previous_);
  currentObservation = previousObservation_;
}

WriteObservation::WriteObservation(std::string operation, std::string product, std::string door,
                                   std::string requestId, FailureReporter* reporter)
    : completion_{std::move(operation), std::move(product), std::move(door), "", "", 0},
      started_(std::chrono::steady_clock::now()), state_(requestState(requestId)), reporter_(reporter),
      serial_(++state_->nextObservation) {
  completion_.requestId = state_->id;
  if (completion_.operation == "auth.session.refresh") return;
  std::uint64_t absent = 0;
  if (state_->infoOwner.compare_exchange_strong(absent, serial_) && completion_.operation == "mcp.transport")
    state_->transportOwner = serial_;
}

WriteObservation::~WriteObservation() {
  if (finished_) return;
  try { finish("failed"); } catch (...) {}
}

const std::string& WriteObservation::requestId() const { return completion_.requestId; }
std::uint64_t WriteObservation::writeCount() const { return state_->writes.load(); }
void WriteObservation::wrote() { ++state_->writes; }

void WriteObservation::ownInfo() {
  if (state_->infoEmitted) return;
  std::uint64_t transport = state_->transportOwner.load();
  if (transport != 0) state_->infoOwner.compare_exchange_strong(transport, serial_);
}

void WriteObservation::skip() {
  if (failed_) {
    finish("failed");
    return;
  }
  finished_ = true;
}

void WriteObservation::finish(std::string outcome) {
  if (finished_.exchange(true)) return;
  completion_.outcome = failed_ ? "failed" : std::move(outcome);
  const double elapsed = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - started_).count();
  completion_.durationMs = std::round(elapsed * 100) / 100;
  completion_.severity = WriteSeverity::warn;
  if (completion_.outcome == "failed") completion_.severity = WriteSeverity::error;
  else if (completion_.outcome == "ok")
    completion_.severity = state_->infoOwner == serial_ && !state_->infoEmitted.exchange(true) ? WriteSeverity::info : WriteSeverity::debug;
  std::function<void(const WriteCompletion&)> sink;
  {
    std::lock_guard lock(configurationMutex);
    sink = installedSink;
  }
  const std::string line = "write " + writeCompletionJson(completion_);
  switch (completion_.severity) {
    case WriteSeverity::debug: { LOG_DEBUG << line; break; }
    case WriteSeverity::info: { LOG_INFO << line; break; }
    case WriteSeverity::warn: { LOG_WARN << line; break; }
    case WriteSeverity::error: { LOG_ERROR << line; break; }
  }
  if (sink) sink(completion_);
}

void WriteObservation::failure(const std::string& exceptionType) {
  if (finished_) return;
  failed_ = true;
  if (!state_->reported.exchange(true)) {
    std::shared_ptr<FailureReporter> reporter;
    {
      std::lock_guard lock(configurationMutex);
      reporter = installedReporter;
    }
    FailureReporter* target = reporter_ ? reporter_ : reporter.get();
    try {
      if (target) target->reportWrite(completion_.operation, completion_.product, completion_.door,
                                     "failed", completion_.requestId, exceptionType);
    } catch (...) {}
  }
}

void WriteObservation::reportFailure(const std::exception& error) { failure(typeid(error).name()); }
void WriteObservation::reportUnknownFailure() { failure("UnknownException"); }
void WriteObservation::fail(const std::exception& error) {
  reportFailure(error);
  finish("failed");
}
void WriteObservation::failUnknown() {
  reportUnknownFailure();
  finish("failed");
}

}
