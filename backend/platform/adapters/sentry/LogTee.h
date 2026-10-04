#pragma once

#include "platform/adapters/sentry/SentryClient.h"

#include <chrono>
#include <cstddef>
#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <thread>

namespace wm {

struct TrantorLine {
  SentryClient::Level level;
  std::string body;
  std::string source;
};

TrantorLine parseTrantorLine(const char* msg, std::size_t len);
std::string oneLine(const char* msg, std::size_t len);
SentryClient::Level logLevelFromEnv(const char* value);

class AsyncLogQueue {
public:
  using Overflow = std::function<void(std::uint64_t)>;
  AsyncLogQueue(int outputFd, Overflow overflow = {}, std::size_t capacity = 1024,
                std::chrono::milliseconds interval = std::chrono::seconds(5), int emergencyFd = -1);
  ~AsyncLogQueue();
  void push(std::string line);
  bool drain(std::chrono::milliseconds timeout = std::chrono::seconds(1));
  bool stop(std::chrono::milliseconds timeout = std::chrono::seconds(2));
  std::uint64_t dropped() const;
  void emergencyDump(int signal) noexcept;
private:
  struct State;
  std::unique_ptr<State> state_;
  std::thread writer_;
};

void installLogTee(std::shared_ptr<SentryClient> sentry, SentryClient::Level minimum,
                   std::FILE* output = stdout);
bool drainLogTee(std::chrono::milliseconds timeout = std::chrono::seconds(1));
bool stopLogTee(std::chrono::milliseconds timeout = std::chrono::seconds(2));

}
