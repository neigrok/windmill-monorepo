#pragma once

#include "platform/domain/Ids.h"

#include <functional>
#include <optional>
#include <string>

namespace wm {

// The finished transcript of a spoken take. Text only — audio never becomes a page.
struct Transcript {
  std::string text;
};

// The voice boundary — an ASR vendor. configured() false means the endpoint answers 503. The audio
// is EPHEMERAL by contract: never persisted, discarded the moment a transcript is produced or the
// attempt fails.
//
// `done` fires exactly once and may fire on any thread, including the vendor client's own loop.
// `nullopt` is a vendor failure and is distinct from an empty transcript.
// `user` meters the call's spend against that account and the process fuse
// (platform/adapters/llm/AnthropicClient.h, meterSpend); nothing here reads it back.
struct Transcriber {
  virtual ~Transcriber() = default;
  virtual bool configured() const = 0;
  virtual void transcribe(const UserId& user, const std::string& audio, const std::string& mimeType,
                          std::function<void(std::optional<Transcript>)> done) = 0;
};

}
