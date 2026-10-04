#include "platform/adapters/sentry/LogTee.h"

#include "test/testing.h"

#include <atomic>
#include <future>
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <unistd.h>
#include <vector>
#include <stdexcept>
#include <string>
#include <thread>

using wm::logLevelFromEnv;
using wm::parseTrantorLine;
using wm::SentryClient;
using wm::TrantorLine;

namespace {
TrantorLine parse(const std::string& line) { return parseTrantorLine(line.data(), line.size()); }

// The real shape, taken from trantor's own writer: date, time, UTC, thread id, a SIX-character level field, the message, then " - file:line". The padding differs per level.
std::string emitted(const std::string& level, const std::string& message,
                    const std::string& source = "Main.cc:42") {
  const std::string field = (level == "INFO" || level == "WARN") ? " " + level + " " : " " + level;
  return "20260802 09:12:33.123456 UTC 1234567" + field + message + " - " + source + "\n";
}
}

TEST(log_tee_reads_every_level_trantor_can_write) {
  CHECK(parse(emitted("TRACE", "m")).level == SentryClient::Level::trace);
  CHECK(parse(emitted("DEBUG", "m")).level == SentryClient::Level::debug);
  CHECK(parse(emitted("INFO", "m")).level == SentryClient::Level::info);
  CHECK(parse(emitted("WARN", "m")).level == SentryClient::Level::warn);
  CHECK(parse(emitted("ERROR", "m")).level == SentryClient::Level::error);
  CHECK(parse(emitted("FATAL", "m")).level == SentryClient::Level::fatal);
}

TEST(log_tee_keeps_the_message_and_moves_the_source_out_of_it) {
  const TrantorLine line = parse(emitted("INFO", "windmill-backend listening on :8080", "main.cc:787"));

  CHECK_EQ(line.body, std::string("windmill-backend listening on :8080"));
  CHECK_EQ(line.source, std::string("main.cc:787"));
  CHECK(line.level == SentryClient::Level::info);
}

// The body is prose and may contain the same separator trantor uses, so the split takes the last one and only when the tail really is file:line.
TEST(log_tee_does_not_mistake_a_dash_in_the_message_for_a_source) {
  const TrantorLine spaced = parse(emitted("WARN", "tending: reaped 3 run(s) - stranded by a restart"));
  CHECK_EQ(spaced.body, std::string("tending: reaped 3 run(s) - stranded by a restart"));
  CHECK_EQ(spaced.source, std::string("Main.cc:42"));

  const std::string bare = "20260802 09:12:33.123456 UTC 1234567 ERROR sentry capture dropped\n";
  const TrantorLine line = parse(bare);
  CHECK_EQ(line.body, std::string("sentry capture dropped"));
  CHECK_EQ(line.source, std::string());
}

// The level search is bounded to the prefix trantor writes, so a message containing "ERROR" stays at the level it was logged at.
TEST(log_tee_reads_the_level_from_the_prefix_and_not_from_the_message) {
  const TrantorLine line = parse(emitted("INFO", "upstream replied ERROR to the probe"));

  CHECK(line.level == SentryClient::Level::info);
  CHECK_EQ(line.body, std::string("upstream replied ERROR to the probe"));
}

// Unparsed is not unsent: a trantor that reshapes its prefix costs the level and the split, never the line.
TEST(log_tee_keeps_an_unrecognisable_line_whole_at_info) {
  const TrantorLine line = parse("a shape trantor has never written\n");

  CHECK(line.level == SentryClient::Level::info);
  CHECK_EQ(line.body, std::string("a shape trantor has never written"));
}

TEST(log_tee_level_knob_defaults_to_info_and_is_case_insensitive) {
  CHECK(logLevelFromEnv(nullptr) == SentryClient::Level::info);
  CHECK(logLevelFromEnv("") == SentryClient::Level::info);
  CHECK(logLevelFromEnv("nonsense") == SentryClient::Level::info);
  CHECK(logLevelFromEnv("warn") == SentryClient::Level::warn);
  CHECK(logLevelFromEnv("Error") == SentryClient::Level::error);
  CHECK(logLevelFromEnv("TRACE") == SentryClient::Level::trace);
}

// One trantor message is one physical line, or whoever can make a log grow an extra line can write that line to say anything.
TEST(log_tee_flattens_a_message_that_tries_to_become_two_lines) {
  const std::string split =
      "20260802 09:12:33.123456 UTC 1234567 WARN  http DELETE /v1/sessions/abc\n"
      "20260816 99:99:99.000000 UTC 1 ERROR auth: account closed user=INJECTED - AuthService.cpp:269"
      " 401 0.0ms caller=anon - AccessLog.cpp:66\n";
  const std::string flat = wm::oneLine(split.data(), split.size());

  CHECK_EQ(flat.find('\n'), flat.size() - 1);
  CHECK_EQ(flat,
           std::string("20260802 09:12:33.123456 UTC 1234567 WARN  http DELETE /v1/sessions/abc\\n"
                       "20260816 99:99:99.000000 UTC 1 ERROR auth: account closed user=INJECTED - "
                       "AuthService.cpp:269 401 0.0ms caller=anon - AccessLog.cpp:66\n"));
}

// The ordinary line goes out byte for byte as trantor wrote it, newline and all.
TEST(log_tee_leaves_an_ordinary_line_alone) {
  const std::string line = emitted("INFO", "http GET /v1/me 200 1.2ms caller=u_1", "AccessLog.cpp:66");

  CHECK_EQ(wm::oneLine(line.data(), line.size()), line);
  CHECK_EQ(wm::oneLine("", 0), std::string("\n"));
}

namespace {
int temporaryOutput() {
  char path[] = "/tmp/windmill-log-test-XXXXXX";
  const int fd = mkstemp(path);
  if (fd >= 0) unlink(path);
  return fd;
}

std::string capturedOutput(int fd) {
  std::string text;
  char buffer[4096];
  ssize_t size;
  while ((size = pread(fd, buffer, sizeof(buffer), text.size())) > 0) text.append(buffer, size);
  return text;
}

void fillPipe(int fd) {
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  const std::string block(4096, 'x');
  while (write(fd, block.data(), block.size()) > 0) {}
}
}

TEST(log_queue_destructor_drains_and_joins_every_accepted_record) {
  const int output = temporaryOutput();
  CHECK(output >= 0);
  {
    wm::AsyncLogQueue queue(output);
    for (int i = 0; i < 500; ++i) queue.push("completion " + std::to_string(i) + "\n");
  }
  std::string expected;
  for (int i = 0; i < 500; ++i) expected += "completion " + std::to_string(i) + "\n";
  CHECK_EQ(capturedOutput(output), expected);
  close(output);
}

TEST(log_queue_permanently_stalled_pipe_bounds_producers_shutdown_and_reports_all_loss) {
  int pipeFds[2];
  CHECK_EQ(pipe(pipeFds), 0);
  fillPipe(pipeFds[1]);
  const int emergency = temporaryOutput();
  std::atomic<std::uint64_t> reported{0};
  std::atomic<int> notices{0};
  wm::AsyncLogQueue queue(pipeFds[1], [&](std::uint64_t count) { reported += count; ++notices; },
                         2, std::chrono::hours(1), emergency);
  auto producer = std::async(std::launch::async, [&] {
    for (int i = 0; i < 10000; ++i) queue.push("completion\n");
  });
  CHECK(producer.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
  producer.get();
  CHECK_FALSE(queue.drain(std::chrono::milliseconds(1)));
  const auto started = std::chrono::steady_clock::now();
  CHECK_FALSE(queue.stop(std::chrono::milliseconds(100)));
  CHECK(std::chrono::steady_clock::now() - started < std::chrono::milliseconds(500));
  CHECK_EQ(queue.dropped(), std::uint64_t{10000});
  CHECK_EQ(reported.load(), std::uint64_t{10000});
  CHECK_EQ(notices.load(), 1);
  const std::string backup = capturedOutput(emergency);
  CHECK(backup.find("completion\ncompletion\n") != std::string::npos);
  CHECK(backup.find("log_queue_loss attempted=10000 written=0 recovered=2 dropped=10000 lost=9998 signal=0") != std::string::npos);
  close(emergency);
  close(pipeFds[0]);
  close(pipeFds[1]);
}

TEST(log_queue_bounds_message_size_and_recovers_a_broken_pipe) {
  int pipeFds[2];
  CHECK_EQ(pipe(pipeFds), 0);
  close(pipeFds[0]);
  const int emergency = temporaryOutput();
  wm::AsyncLogQueue queue(pipeFds[1], {}, 1024, std::chrono::seconds(5), emergency);
  queue.push(std::string(8193, 'x'));
  queue.push("completion\n");
  CHECK(queue.drain(std::chrono::seconds(2)));
  CHECK_FALSE(queue.stop());
  CHECK_EQ(queue.dropped(), std::uint64_t{2});
  const std::string backup = capturedOutput(emergency);
  CHECK(backup.find("completion\n") != std::string::npos);
  CHECK(backup.find("recovered=1 dropped=2 lost=1 signal=0") != std::string::npos);
  close(emergency);
  close(pipeFds[1]);
}

TEST(log_queue_emergency_path_preserves_pending_records_without_the_queue_lock) {
  int pipeFds[2];
  CHECK_EQ(pipe(pipeFds), 0);
  fillPipe(pipeFds[1]);
  const int emergency = temporaryOutput();
  wm::AsyncLogQueue queue(pipeFds[1], {}, 1024, std::chrono::seconds(5), emergency);
  for (int i = 0; i < 500; ++i) queue.push("completion " + std::to_string(i) + "\n");
  queue.emergencyDump(SIGABRT);
  const std::string backup = capturedOutput(emergency);
  std::string expected;
  for (int i = 0; i < 500; ++i) expected += "completion " + std::to_string(i) + "\n";
  CHECK(backup.find(expected) == 0);
  CHECK(backup.find("attempted=500 written=0 recovered=500 dropped=500 lost=0 signal=") != std::string::npos);
  close(emergency);
  close(pipeFds[0]);
  close(pipeFds[1]);
}
