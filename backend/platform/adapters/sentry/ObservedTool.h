#pragma once

#include "platform/application/WriteObservation.h"

#include <functional>
#include <memory>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace wm {
void installToolObservability(bool protocolStdout = false);
void stopToolObservability();

class ObservabilityLifetime {
public:
  explicit ObservabilityLifetime(std::function<void()> finish = stopToolObservability)
      : finish_(std::move(finish)) {}
  ~ObservabilityLifetime() { stop(); }
  ObservabilityLifetime(const ObservabilityLifetime&) = delete;
  ObservabilityLifetime& operator=(const ObservabilityLifetime&) = delete;

  void onStop(std::function<void()> stop) { stops_.push_back(std::move(stop)); }

  template <typename... Dependencies>
  void onStop(std::function<void()> stop, std::shared_ptr<Dependencies>... dependencies) {
    onStop([stop = std::move(stop), dependencies = std::make_tuple(std::move(dependencies)...)] {
      static_cast<void>(dependencies);
      stop();
    });
  }

  template <typename Producer, typename... Dependencies>
  void watch(std::shared_ptr<Producer> producer, std::shared_ptr<Dependencies>... dependencies) {
    onStop([producer = std::move(producer), dependencies = std::make_tuple(std::move(dependencies)...)] {
      static_cast<void>(dependencies);
      producer->stop();
    });
  }

  void stop() {
    if (std::exchange(stopped_, true)) return;
    for (auto stop = stops_.rbegin(); stop != stops_.rend(); ++stop) {
      try { (*stop)(); }
      catch (const std::exception& error) {
        WriteObservation observation("process.shutdown", "platform", "background");
        observation.fail(error);
      } catch (...) {
        WriteObservation observation("process.shutdown", "platform", "background");
        observation.failUnknown();
      }
    }
    stops_.clear();
    try { finish_(); }
    catch (...) {}
  }

private:
  std::function<void()> finish_;
  std::vector<std::function<void()>> stops_;
  bool stopped_ = false;
};
}
