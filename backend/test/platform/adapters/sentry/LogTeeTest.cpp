#include "platform/adapters/sentry/LogTee.h"

#include "test/testing.h"

#include <string>

using wm::logLevelFromEnv;
using wm::parseTrantorLine;
using wm::SentryClient;
using wm::TrantorLine;

namespace {
TrantorLine parse(const std::string& line) { return parseTrantorLine(line.data(), line.size()); }

// The real shape, taken from trantor's own writer: date, time, UTC, thread id, a SIX-character
// level field, the message, then " - file:line". The padding differs per level — " ERROR" carries
// none where " INFO " carries one — which is exactly what a fixed-offset parse would get wrong.
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

// The body is prose and may contain the same separator trantor uses. Splitting on the last one, and
// only when the tail really is file:line, is what keeps a sentence from being filed as a location.
TEST(log_tee_does_not_mistake_a_dash_in_the_message_for_a_source) {
  const TrantorLine spaced = parse(emitted("WARN", "tending: reaped 3 run(s) - stranded by a restart"));
  CHECK_EQ(spaced.body, std::string("tending: reaped 3 run(s) - stranded by a restart"));
  CHECK_EQ(spaced.source, std::string("Main.cc:42"));

  // No source suffix at all: the whole message survives and nothing is invented.
  const std::string bare = "20260802 09:12:33.123456 UTC 1234567 ERROR sentry capture dropped\n";
  const TrantorLine line = parse(bare);
  CHECK_EQ(line.body, std::string("sentry capture dropped"));
  CHECK_EQ(line.source, std::string());
}

// A level word inside the message must not outrank the real one — the search is bounded to the
// prefix trantor writes, so a handler logging the text "ERROR" stays at the level it was logged at.
TEST(log_tee_reads_the_level_from_the_prefix_and_not_from_the_message) {
  const TrantorLine line = parse(emitted("INFO", "upstream replied ERROR to the probe"));

  CHECK(line.level == SentryClient::Level::info);
  CHECK_EQ(line.body, std::string("upstream replied ERROR to the probe"));
}

// Unparsed is not unsent. A trantor that reshapes its prefix costs the level and the split; it must
// never cost the line, because the line is the thing someone is looking for at 3am.
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
