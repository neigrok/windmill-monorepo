#pragma once

#include "platform/adapters/sentry/SentryClient.h"

#include <cstddef>
#include <memory>
#include <string>

namespace wm {

// Every LOG_* in this backend — ours and Drogon's own — passes through one trantor output function.
// The tee keeps stdout exactly as it was (the container's logs stay the source of truth a `docker
// logs` reads) and forwards a copy to Sentry, so the two never disagree about what happened.
//
// trantor hands over the FORMATTED line and nothing else, so the level has to be read back out of
// it. That is the whole reason this lives beside the client rather than inside it: parsing trantor's
// prefix is a trantor concern, and SentryClient should know only the wire.
struct TrantorLine {
  SentryClient::Level level;
  std::string body;    // the message, prefix and source suffix removed
  std::string source;  // "file.cc:42" when trantor appended one
};

// Split a formatted trantor line. Exposed for its own test — the shape it parses is the one thing
// here that a trantor upgrade can silently change, and a silent change means every log arrives at
// one level with the timestamp glued to the front.
TrantorLine parseTrantorLine(const char* msg, std::size_t len);

// One trantor message as ONE physical line: any embedded CR/LF escaped, and exactly one trailing
// newline, in ONE buffer so the whole record reaches stdout in a single write. (Body and newline as
// two stdio calls take the FILE lock twice, and another thread's line lands in the gap.) A record that can be split is a record a stranger can forge: an anonymous request whose
// path carried `%0a` — which drogon URL-decodes — once minted a byte-perfect second line reading
// `auth: account closed user=…`. The seams that build lines escape their own caller-steered fields
// (platform/adapters/http/LogFormat.h); this is the floor under all of them, ours and drogon's.
std::string oneLine(const char* msg, std::size_t len);

// Installs the output function. Lines below `minimum` are written to stdout and not forwarded, which
// is the cost knob: SENTRY_LOG_LEVEL. Anything logged on the client's own loop thread is never
// forwarded, so a failed send reporting itself cannot feed the buffer it failed to drain.
void installLogTee(std::shared_ptr<SentryClient> sentry, SentryClient::Level minimum);

// Parses SENTRY_LOG_LEVEL. Unknown or unset reads as `info` — the level a server run is worth
// keeping, without the per-request debug chatter nobody pays to store.
SentryClient::Level logLevelFromEnv(const char* value);

}
