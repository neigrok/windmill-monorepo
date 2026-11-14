#pragma once

#include "platform/domain/Ids.h"

#include <functional>
#include <optional>
#include <string>
#include <utility>

namespace wm {

// What one take came back as. `text` holds the words, and an empty text is a take with no words in it, never a
// failure. With no text, `refusal` is the AI allowance code that kept the audio on the server, and no refusal is a
// failure to transcribe.
struct Transcription {
  std::optional<std::string> text;
  std::string refusal;

  static Transcription words(std::string text) { return {std::move(text), {}}; }
  static Transcription refused(std::string code) { return {std::nullopt, std::move(code)}; }
  static Transcription failed() { return {}; }
};

// configured() false means the endpoint answers 503. Audio is never persisted: discard it the
// moment a transcript is produced or the attempt fails.
// `done` fires exactly once and may fire on any thread. `user` is the account whose AI allowance the
// take draws on.
struct Transcriber {
  virtual ~Transcriber() = default;
  virtual bool configured() const = 0;
  virtual void transcribe(const UserId& user, const std::string& audio, const std::string& mimeType,
                          std::function<void(Transcription)> done) = 0;
};

}
