#pragma once

#include "platform/ports/FailureReporter.h"

#include <chrono>
#include <atomic>
#include <exception>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>

namespace wm {

struct WriteRequestState;
enum class WriteSeverity { debug, info, warn, error };
struct WriteCompletion {
  std::string operation;
  std::string product;
  std::string door;
  std::string outcome;
  std::string requestId;
  double durationMs;
  WriteSeverity severity = WriteSeverity::debug;
  std::uint64_t attempts = 0;  // how many tries a retried write took; 0 for a write that is not one, and off its line
};
std::string writeCompletionJson(const WriteCompletion& completion);

void installWriteReporter(std::shared_ptr<FailureReporter> reporter);
void installWriteSink(std::function<void(const WriteCompletion&)> sink);
std::string writeRequestId();
// A request id of its own, whatever write is in progress: for an observation that is no part of the request it happens
// under, so its report does not take that request's one Issue.
std::string freshWriteRequestId();
std::string currentWriteRequestId();
// The door the write in progress came through (`mcp`, `Coach`, …), or "" outside one: a write a handler observes beside
// it is told at the same door.
std::string currentWriteDoor();
bool claimWriteIssue();
void reportCurrentWriteFailure(const std::exception& error);
void reportCurrentUnknownWriteFailure();
void finishCurrentWriteRefusal(const std::string& code);
// The write in progress landed nothing: outcome `unchanged`, an expected one that completes at the level `ok` takes.
void finishCurrentWriteUnchanged();
// The write in progress completes as `outcome` when its door finishes it, whatever the door then calls it, unless it
// fails: for a consequence met beneath the door, which every door's line must tell alike.
void settleCurrentWriteAs(const std::string& outcome);
void markCurrentWrite();

class WriteObservation;
class WriteContext {
public:
  explicit WriteContext(const std::string& requestId);
  explicit WriteContext(WriteObservation& observation);
  ~WriteContext();
  WriteContext(const WriteContext&) = delete;
  WriteContext& operator=(const WriteContext&) = delete;
private:
  std::shared_ptr<WriteRequestState> previous_;
  WriteObservation* previousObservation_;
};

class WriteObservation {
public:
  WriteObservation(std::string operation, std::string product, std::string door,
                   std::string requestId = "", FailureReporter* reporter = nullptr);
  ~WriteObservation();
  WriteObservation(const WriteObservation&) = delete;
  WriteObservation& operator=(const WriteObservation&) = delete;
  void finish(std::string outcome = "ok");
  // The write landed on a retry: its line carries how many tries it took.
  void tried(std::uint64_t attempts) { completion_.attempts = attempts; }
  void settleAs(std::string outcome) { settledOutcome_ = std::move(outcome); }
  void skip();
  void ownInfo();
  void wrote();
  std::uint64_t writeCount() const;
  // Whether this observation failed, or its request reported a failure through any observation.
  bool reportedFailure() const;
  void fail(const std::exception& error);
  // fail() under an outcome of its own in place of `failed`, still at ERROR and still the request's Issue: a failure
  // whose consequence has a name the line should carry.
  void fail(const std::exception& error, std::string outcome);
  void reportFailure(const std::exception& error);
  void reportUnknownFailure();
  void failUnknown();
  const std::string& requestId() const;
  const std::string& door() const { return completion_.door; }
private:
  friend class WriteContext;
  void failure(const std::string& exceptionType);
  WriteCompletion completion_;
  std::chrono::steady_clock::time_point started_;
  std::shared_ptr<WriteRequestState> state_;
  FailureReporter* reporter_;
  std::uint64_t serial_;
  std::atomic<bool> finished_{false};
  std::atomic<bool> failed_{false};
  std::string failedOutcome_ = "failed";
  std::string settledOutcome_;
};

template<class Run>
decltype(auto) observeWrite(const std::string& operation, const std::string& product,
                           const std::string& door, Run&& run) {
  WriteObservation observation(operation, product, door);
  WriteContext context(observation);
  try {
    if constexpr (std::is_void_v<std::invoke_result_t<Run>>) {
      std::forward<Run>(run)();
      observation.finish();
      return;
    } else {
      auto result = std::forward<Run>(run)();
      observation.finish();
      return result;
    }
  } catch (const std::exception& error) {
    observation.fail(error);
    throw;
  } catch (...) {
    observation.failUnknown();
    throw;
  }
}

}
