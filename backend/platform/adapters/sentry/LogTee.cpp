#include "platform/adapters/sentry/LogTee.h"

#include "platform/adapters/http/LogFormat.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <utility>
#include <array>
#include <atomic>
#include <cerrno>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <time.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cstdio>
#include <string>
#include <string_view>

namespace wm {

namespace {
struct LevelToken {
  std::string_view word;
  SentryClient::Level level;
};

constexpr LevelToken kLevels[] = {
    {"TRACE", SentryClient::Level::trace}, {"DEBUG", SentryClient::Level::debug},
    {"INFO", SentryClient::Level::info},   {"WARN", SentryClient::Level::warn},
    {"ERROR", SentryClient::Level::error}, {"FATAL", SentryClient::Level::fatal},
};

constexpr std::size_t kPrefixSearchLimit = 64;
}

TrantorLine parseTrantorLine(const char* msg, std::size_t len) {
  std::string_view line(msg, len);
  while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.remove_suffix(1);

  TrantorLine parsed{SentryClient::Level::info, std::string(line), std::string()};

  const std::size_t horizon = std::min(line.size(), kPrefixSearchLimit);
  const std::string_view prefix = line.substr(0, horizon);
  for (const LevelToken& candidate : kLevels) {
    const std::size_t at = prefix.find(candidate.word);
    if (at == std::string_view::npos) continue;
    std::string_view rest = line.substr(at + candidate.word.size());
    while (!rest.empty() && rest.front() == ' ') rest.remove_prefix(1);
    parsed.level = candidate.level;
    parsed.body = std::string(rest);
    break;
  }

  const std::size_t separator = parsed.body.rfind(" - ");
  if (separator != std::string::npos) {
    const std::string tail = parsed.body.substr(separator + 3);
    const std::size_t colon = tail.rfind(':');
    const bool isSource = colon != std::string::npos && colon + 1 < tail.size() &&
                          tail.find(' ') == std::string::npos &&
                          std::all_of(tail.begin() + colon + 1, tail.end(),
                                      [](unsigned char c) { return std::isdigit(c) != 0; });
    if (isSource) {
      parsed.source = tail;
      parsed.body.erase(separator);
    }
  }
  return parsed;
}

SentryClient::Level logLevelFromEnv(const char* value) {
  if (value == nullptr) return SentryClient::Level::info;
  std::string wanted(value);
  std::transform(wanted.begin(), wanted.end(), wanted.begin(),
                 [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
  for (const LevelToken& candidate : kLevels) {
    if (wanted == candidate.word) return candidate.level;
  }
  return SentryClient::Level::info;
}

std::string oneLine(const char* msg, std::size_t len) {
  const std::size_t body = (len > 0 && msg[len - 1] == '\n') ? len - 1 : len;
  std::string flat;
  flat.reserve(body + 1);
  for (std::size_t at = 0; at < body; ++at) {
    if (msg[at] == '\n') flat += "\\n";
    else if (msg[at] == '\r') flat += "\\r";
    else flat.push_back(msg[at]);
  }
  flat.push_back('\n');
  return flat;
}

namespace {
constexpr std::size_t kMaxLine = 8192;
constexpr int kFatalSignals[] = {SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGTRAP};
static_assert(std::atomic<std::uint64_t>::is_always_lock_free);
static_assert(std::atomic<unsigned>::is_always_lock_free);
static_assert(std::atomic<bool>::is_always_lock_free);

std::int64_t monotonicMs() noexcept {
  timespec time{};
  clock_gettime(CLOCK_MONOTONIC, &time);
  return time.tv_sec * 1000LL + time.tv_nsec / 1000000;
}

bool writeBefore(int fd, const char* data, std::size_t length, std::int64_t deadline) noexcept {
  std::size_t offset = 0;
  while (offset < length) {
    if (monotonicMs() >= deadline) return false;
    const auto count = ::write(fd, data + offset, length - offset);
    if (count > 0) { offset += static_cast<std::size_t>(count); continue; }
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      continue;
    }
    return false;
  }
  return true;
}

int duplicateNonblocking(int fd) {
  const int copy = dup(fd);
  if (copy < 0) return -1;
  fcntl(copy, F_SETFD, FD_CLOEXEC);
  const int flags = fcntl(copy, F_GETFL);
  if (flags < 0 || fcntl(copy, F_SETFL, flags | O_NONBLOCK) < 0) {
    close(copy);
    return -1;
  }
  return copy;
}

char* appendNumber(char* end, std::uint64_t value) noexcept {
  char digits[20];
  unsigned count = 0;
  do { digits[count++] = '0' + value % 10; value /= 10; } while (value);
  while (count) *end++ = digits[--count];
  return end;
}

char* appendText(char* end, const char* text) noexcept {
  while (*text) *end++ = *text++;
  return end;
}
}

struct AsyncLogQueue::State {
  struct Slot {
    std::array<char, kMaxLine> text;
    std::atomic<unsigned> length{0};
  };
  const int output;
  const int emergency;
  Overflow report;
  const std::size_t capacity;
  const std::chrono::milliseconds interval;
  std::unique_ptr<Slot[]> slots;
  std::mutex mutex;
  std::condition_variable changed;
  std::size_t head = 0;
  std::size_t tail = 0;
  std::size_t count = 0;
  bool closing = false;
  std::int64_t deadline = 0;
  std::atomic<bool> accepting{true};
  std::atomic<bool> fatal{false};
  std::atomic<bool> active{false};
  std::atomic<unsigned> producers{0};
  std::atomic<std::uint64_t> attempted{0};
  std::atomic<std::uint64_t> written{0};
  std::atomic<std::uint64_t> dropped{0};
  std::atomic<std::uint64_t> recovered{0};
  std::uint64_t reported = 0;
  std::int64_t reportedAt = monotonicMs();
  std::string notice;

  State(int fd, Overflow overflow, std::size_t limit, std::chrono::milliseconds period, int backup)
      : output(duplicateNonblocking(fd)), emergency(duplicateNonblocking(backup)),
        report(std::move(overflow)), capacity(std::max<std::size_t>(1, limit)), interval(period),
        slots(std::make_unique<Slot[]>(capacity)) {}

  ~State() {
    if (output >= 0) close(output);
    if (emergency >= 0) close(emergency);
  }

  void reportOverflow(bool final = false) {
    const auto total = dropped.load();
    if (total == reported || (!final && monotonicMs() - reportedAt < interval.count())) return;
    const auto delta = total - reported;
    reported = total;
    reportedAt = monotonicMs();
    notice = "WARN log_queue_overflow dropped=" + std::to_string(delta) +
             " total=" + std::to_string(total) + " - LogTee.cpp:0\n";
    if (emergency >= 0) writeBefore(emergency, notice.data(), notice.size(), monotonicMs() + 25);
    if (!report) return;
    try { report(delta); } catch (...) {}
  }

  bool writePrimary(const char* data, std::size_t length) {
    std::size_t offset = 0;
    while (offset < length && !fatal.load()) {
      std::int64_t until;
      {
        std::lock_guard lock(mutex);
        until = closing ? deadline : monotonicMs() + 25;
        if (closing && monotonicMs() >= until) return false;
      }
      const auto size = ::write(output, data + offset, length - offset);
      if (size > 0) { offset += static_cast<std::size_t>(size); continue; }
      if (size < 0 && errno == EINTR) continue;
      if (size < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        pollfd fd{output, POLLOUT, 0};
        poll(&fd, 1, static_cast<int>(std::max<std::int64_t>(0, std::min<std::int64_t>(25, until - monotonicMs()))));
        reportOverflow();
        continue;
      }
      return false;
    }
    return offset == length;
  }

  void summary(int signal, std::uint64_t recovered) noexcept {
    char text[384];
    char* end = appendText(text, "WARN log_queue_loss attempted=");
    const auto total = attempted.load();
    const auto emitted = written.load();
    end = appendNumber(end, total);
    end = appendText(end, " written="); end = appendNumber(end, emitted);
    end = appendText(end, " recovered="); end = appendNumber(end, recovered);
    end = appendText(end, " dropped="); end = appendNumber(end, total - emitted);
    end = appendText(end, " lost="); end = appendNumber(end, total > emitted + recovered ? total - emitted - recovered : 0);
    end = appendText(end, " signal="); end = appendNumber(end, signal);
    end = appendText(end, " - LogTee.cpp:0\n");
    const auto length = static_cast<std::size_t>(end - text);
    if (emergency >= 0) writeBefore(emergency, text, length, monotonicMs() + 100);
    if (!signal) writeBefore(output, text, length, monotonicMs() + 1);
  }

  std::uint64_t recover(std::int64_t until) noexcept {
    std::uint64_t recovered = 0;
    for (std::size_t index = 0; index < capacity; ++index) {
      const auto size = slots[index].length.load(std::memory_order_acquire);
      if (!size || size > kMaxLine) continue;
      if (emergency >= 0 && writeBefore(emergency, slots[index].text.data(), size, until)) ++recovered;
    }
    return recovered;
  }

  void run() {
    sigset_t signals;
    sigemptyset(&signals);
    for (const auto signal : kFatalSignals) sigaddset(&signals, signal);
    sigaddset(&signals, SIGPIPE);
    pthread_sigmask(SIG_BLOCK, &signals, nullptr);
    for (;;) {
      std::unique_lock lock(mutex);
      changed.wait_for(lock, std::chrono::milliseconds(25), [&] { return closing || fatal.load() || count; });
      if (fatal.load()) return;
      lock.unlock();
      reportOverflow();
      lock.lock();
      if (!count) {
        if (closing) break;
        continue;
      }
      if (closing && monotonicMs() >= deadline) break;
      Slot& slot = slots[head];
      active.store(true);
      lock.unlock();
      if (!notice.empty()) {
        const std::string pending = std::exchange(notice, {});
        writePrimary(pending.data(), pending.size());
      }
      const bool emitted = writePrimary(slot.text.data(), slot.length.load(std::memory_order_acquire));
      if (fatal.load()) {
        if (emitted) { ++written; slot.length.store(0); }
        active.store(false);
        return;
      }
      lock.lock();
      if (!emitted && closing && monotonicMs() >= deadline) { active.store(false); break; }
      lock.unlock();
      if (!emitted) {
        ++dropped;
        if (emergency >= 0 && writeBefore(emergency, slot.text.data(), slot.length.load(), monotonicMs() + 25)) ++recovered;
      } else ++written;
      lock.lock();
      slot.length.store(0, std::memory_order_release);
      head = (head + 1) % capacity;
      --count;
      active.store(false);
      changed.notify_all();
    }
    active.store(true);
    {
      std::lock_guard lock(mutex);
      dropped += count;
    }
    recovered += recover(monotonicMs() + 100);
    {
      std::lock_guard lock(mutex);
      for (std::size_t index = 0; index < capacity; ++index) slots[index].length.store(0);
      count = 0;
    }
    reportOverflow(true);
    if (!notice.empty()) writeBefore(output, notice.data(), notice.size(), monotonicMs() + 1);
    if (dropped.load()) summary(0, recovered.load());
    active.store(false);
    {
      std::lock_guard lock(mutex);
      changed.notify_all();
    }
  }
};

AsyncLogQueue::AsyncLogQueue(int outputFd, Overflow overflow, std::size_t capacity,
                             std::chrono::milliseconds interval, int emergencyFd)
    : state_(std::make_unique<State>(outputFd, std::move(overflow), capacity, interval, emergencyFd)),
      writer_([this] { state_->run(); }) {}

AsyncLogQueue::~AsyncLogQueue() { stop(); }

void AsyncLogQueue::push(std::string line) {
  ++state_->producers;
  ++state_->attempted;
  {
    std::lock_guard lock(state_->mutex);
    if (!state_->accepting.load() || state_->count >= state_->capacity || line.size() > kMaxLine) ++state_->dropped;
    else {
      auto& slot = state_->slots[state_->tail];
      std::memcpy(slot.text.data(), line.data(), line.size());
      slot.length.store(static_cast<unsigned>(line.size()), std::memory_order_release);
      state_->tail = (state_->tail + 1) % state_->capacity;
      ++state_->count;
    }
  }
  --state_->producers;
  state_->changed.notify_one();
}

bool AsyncLogQueue::drain(std::chrono::milliseconds timeout) {
  std::unique_lock lock(state_->mutex);
  return state_->changed.wait_for(lock, timeout, [&] { return !state_->count && !state_->active.load(); });
}

bool AsyncLogQueue::stop(std::chrono::milliseconds timeout) {
  state_->accepting.store(false);
  {
    std::lock_guard lock(state_->mutex);
    if (!state_->closing) {
      state_->closing = true;
      state_->deadline = monotonicMs() + std::max<std::int64_t>(0, timeout.count());
    }
    state_->changed.notify_all();
  }
  if (writer_.joinable()) writer_.join();
  return state_->dropped.load() == 0;
}

std::uint64_t AsyncLogQueue::dropped() const { return state_->dropped.load(); }

void AsyncLogQueue::emergencyDump(int signal) noexcept {
  state_->accepting.store(false);
  state_->fatal.store(true);
  const auto until = monotonicMs() + 100;
  while ((state_->producers.load() || state_->active.load()) && monotonicMs() < until) {}
  const auto recovered = state_->recovered.load() + state_->recover(monotonicMs() + 1000);
  state_->summary(signal, recovered);
}

namespace {
std::shared_ptr<AsyncLogQueue> installedQueue;
std::atomic<bool> acceptingLogs{false};
std::atomic<AsyncLogQueue*> signalQueue{nullptr};
static_assert(std::atomic<AsyncLogQueue*>::is_always_lock_free);
std::array<struct sigaction, std::size(kFatalSignals)> originalHandlers;
bool installedHandlers = false;

void fatalLogSignal(int signal) {
  if (auto* queue = signalQueue.load()) queue->emergencyDump(signal);
  struct sigaction action{};
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  sigaction(signal, &action, nullptr);
  sigset_t unblocked;
  sigemptyset(&unblocked);
  sigaddset(&unblocked, signal);
  sigprocmask(SIG_UNBLOCK, &unblocked, nullptr);
  kill(getpid(), signal);
  _exit(128 + signal);
}
}

void installLogTee(std::shared_ptr<SentryClient> sentry, SentryClient::Level minimum,
                   std::FILE* output) {
  stopLogTee();
  constexpr trantor::Logger::LogLevel outputLevels[] = {trantor::Logger::kTrace, trantor::Logger::kDebug,
      trantor::Logger::kInfo, trantor::Logger::kWarn, trantor::Logger::kError, trantor::Logger::kFatal};
  trantor::Logger::setLogLevel(outputLevels[static_cast<unsigned>(logLevelFromEnv(std::getenv("WINDMILL_LOG_LEVEL")))]);
  const char* configured = std::getenv("WINDMILL_LOG_EMERGENCY_FILE");
  const std::string path = configured ? configured : "/tmp/windmill-" + std::to_string(getpid()) + ".emergency.log";
  int backup = open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (backup >= 0) {
    struct stat info{};
    if (fstat(backup, &info) != 0 || !S_ISREG(info.st_mode)) { close(backup); backup = -1; }
    else fchmod(backup, 0600);
  }
  auto queue = std::make_shared<AsyncLogQueue>(fileno(output), [sentry](std::uint64_t count) {
    sentry->log(SentryClient::Level::warn, "log_queue_overflow dropped=" + std::to_string(count), "LogTee.cpp:0");
  }, 1024, std::chrono::seconds(5), backup);
  if (backup >= 0) close(backup);
  installedQueue = queue;
  acceptingLogs.store(true);
  signalQueue.store(queue.get());
  struct sigaction action{};
  action.sa_handler = fatalLogSignal;
  sigemptyset(&action.sa_mask);
  for (const auto signal : kFatalSignals) sigaddset(&action.sa_mask, signal);
  sigaddset(&action.sa_mask, SIGPIPE);
  for (std::size_t index = 0; index < std::size(kFatalSignals); ++index)
    sigaction(kFatalSignals[index], &action, &originalHandlers[index]);
  installedHandlers = true;
  trantor::Logger::setOutputFunction(
      [queue, sentry, minimum](const char* msg, const std::uint64_t len) {
        if (!acceptingLogs.load() && sentry->onReportingThread()) return;
        const std::string original = oneLine(msg, static_cast<std::size_t>(len));
        TrantorLine line = parseTrantorLine(original.data(), original.size());
        const std::string source = privacySafeLogSource(line.source);
        const std::string body = privacySafeLogBody(line.body, source);
        if (!acceptingLogs.load() && body == "framework diagnostic suppressed") return;
        std::string text = original;
        if (source != line.source || body != line.body) {
          const auto level = std::find_if(std::begin(kLevels), std::end(kLevels), [&](const auto& token) {
            return token.level == line.level;
          });
          text = std::string(level->word) + " " + body + " - " + source + "\n";
        }
        if (!sentry->onReportingThread() && line.level >= minimum) sentry->log(line.level, body, source);
        queue->push(std::move(text));
      }, [] {});
}

bool drainLogTee(std::chrono::milliseconds timeout) {
  return !installedQueue || installedQueue->drain(timeout);
}

bool stopLogTee(std::chrono::milliseconds timeout) {
  acceptingLogs.store(false);
  const bool drained = !installedQueue || installedQueue->stop(timeout);
  if (installedHandlers) {
    signalQueue.store(nullptr);
    for (std::size_t index = 0; index < std::size(kFatalSignals); ++index)
      sigaction(kFatalSignals[index], &originalHandlers[index], nullptr);
    installedHandlers = false;
  }
  return drained;
}

}
