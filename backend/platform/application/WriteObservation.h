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
};
std::string writeCompletionJson(const WriteCompletion& completion);

void installWriteReporter(std::shared_ptr<FailureReporter> reporter);
void installWriteSink(std::function<void(const WriteCompletion&)> sink);
std::string writeRequestId();
std::string currentWriteRequestId();
bool claimWriteIssue();
void reportCurrentWriteFailure(const std::exception& error);
void reportCurrentUnknownWriteFailure();
void finishCurrentWriteRefusal(const std::string& code);
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
  void skip();
  void ownInfo();
  void wrote();
  std::uint64_t writeCount() const;
  void fail(const std::exception& error);
  void reportFailure(const std::exception& error);
  void reportUnknownFailure();
  void failUnknown();
  const std::string& requestId() const;
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
