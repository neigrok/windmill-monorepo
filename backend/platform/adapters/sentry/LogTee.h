#pragma once

#include "platform/adapters/sentry/SentryClient.h"

#include <cstddef>
#include <memory>
#include <string>

namespace wm {

// Every LOG_* in this backend — ours and Drogon's own — passes through one trantor output function.
// The tee keeps stdout as it was and forwards a copy to Sentry.
struct TrantorLine {
  SentryClient::Level level;
  std::string body;    // the message, prefix and source suffix removed
  std::string source;  // "file.cc:42" when trantor appended one
};

TrantorLine parseTrantorLine(const char* msg, std::size_t len);

// One trantor message as ONE physical line: any embedded CR/LF escaped, and exactly one trailing
// newline, in ONE buffer so the whole record reaches stdout in a single write. (Body and newline as
// two stdio calls take the FILE lock twice, and another thread's line lands in the gap.)
std::string oneLine(const char* msg, std::size_t len);

// Installs the output function. Lines below `minimum` are written to stdout and not forwarded.
// Anything logged on the client's own loop thread is never forwarded, so a failed send reporting
// itself cannot feed the buffer it failed to drain.
void installLogTee(std::shared_ptr<SentryClient> sentry, SentryClient::Level minimum);

// Parses SENTRY_LOG_LEVEL. Unknown or unset reads as `info`.
SentryClient::Level logLevelFromEnv(const char* value);

}
