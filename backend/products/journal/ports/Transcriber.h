#pragma once

#include "platform/domain/Ids.h"

#include <functional>
#include <optional>
#include <string>

namespace wm {

struct Transcript {
  std::string text;
};

// configured() false means the endpoint answers 503. Audio is never persisted: discard it the
// moment a transcript is produced or the attempt fails.
// `done` fires exactly once and may fire on any thread. `nullopt` is a vendor failure, distinct
// from an empty transcript. `user` meters the call's spend against that account.
struct Transcriber {
  virtual ~Transcriber() = default;
  virtual bool configured() const = 0;
  virtual void transcribe(const UserId& user, const std::string& audio, const std::string& mimeType,
                          std::function<void(std::optional<Transcript>)> done) = 0;
};

}
