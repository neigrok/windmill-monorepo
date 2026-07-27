#pragma once

#include <string>

namespace wm {

// The finished transcript of a spoken take. Text only — audio never becomes a page; the client
// drops this into today's page with source = spoken.
struct Transcript {
  std::string text;
};

// The voice boundary, BOUGHT from an ASR vendor (a Windmill One feature). configured() is false when
// no vendor is wired, and the endpoint answers 503 rather than pretend a model exists. The audio is
// EPHEMERAL by contract: an implementation must never persist it and must discard it the moment a
// transcript is produced (or the attempt fails). This seam keeps the whole vendor choice — and the
// discard promise — in one swappable place; a fake returns fixed text so the gate is testable.
struct Transcriber {
  virtual ~Transcriber() = default;
  virtual bool configured() const = 0;
  virtual Transcript transcribe(const std::string& audio, const std::string& mimeType) = 0;
};

}
