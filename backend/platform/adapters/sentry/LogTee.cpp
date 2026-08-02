#include "platform/adapters/sentry/LogTee.h"

#include <trantor/utils/Logger.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <string_view>

namespace wm {

namespace {
// trantor writes the level as a fixed six-character field, so the padding differs by level
// (" ERROR" carries none, " INFO " carries one). Matching the word and then eating whatever spaces
// follow is what makes the parse survive that, and a future trantor that pads differently.
struct LevelToken {
  std::string_view word;
  SentryClient::Level level;
};

constexpr LevelToken kLevels[] = {
    {"TRACE", SentryClient::Level::trace}, {"DEBUG", SentryClient::Level::debug},
    {"INFO", SentryClient::Level::info},   {"WARN", SentryClient::Level::warn},
    {"ERROR", SentryClient::Level::error}, {"FATAL", SentryClient::Level::fatal},
};

// The level word never appears further in than the timestamp and thread id put it. Bounding the
// search keeps a message that merely CONTAINS the word "ERROR" from being read as the level.
constexpr std::size_t kPrefixSearchLimit = 64;
}

TrantorLine parseTrantorLine(const char* msg, std::size_t len) {
  std::string_view line(msg, len);
  while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.remove_suffix(1);

  // Unparsed is not unsent: an unrecognised shape keeps the whole line as the body at info, so a
  // trantor that changes its prefix costs fidelity and never costs the log itself.
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

  // trantor appends " - file.cc:42". Split on the LAST separator and only when what follows really
  // is a source location, because a message is free to contain " - " and usually means it.
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

void installLogTee(std::shared_ptr<SentryClient> sentry, SentryClient::Level minimum) {
  // Line-buffer stdout before anything writes to it. Redirected — which is what a container does —
  // stdio buffers in 4 KB blocks and drops whatever is still held when the process takes a signal.
  // Docker stops a container with SIGTERM, so the last block written before every deploy was being
  // lost: exactly the lines that say why the process was going down. Measured against a syscall per
  // line, having the record survive the shutdown is the trade worth making.
  std::setvbuf(stdout, nullptr, _IOLBF, 0);
  trantor::Logger::setOutputFunction(
      [sentry, minimum](const char* msg, const std::uint64_t len) {
        // stdout first and unconditionally: the container's log is the record that must not depend
        // on a network, a DSN, or anything this tee decides afterwards.
        std::fwrite(msg, 1, len, stdout);
        if (sentry->onReportingThread()) return;
        const TrantorLine line = parseTrantorLine(msg, static_cast<std::size_t>(len));
        if (line.level < minimum) return;
        sentry->log(line.level, line.body, line.source);
      },
      [] { std::fflush(stdout); });
}

}
