#pragma once

#include "products/journal/ports/Transcriber.h"

namespace wm {

// The default transcriber when no ASR vendor is wired: configured() is false, so the transcribe
// endpoint answers 503 and the client hides the Talk control. A real vendor replaces this behind
// the Transcriber port; nothing else in the voice path moves.
struct NullTranscriber : Transcriber {
  bool configured() const override { return false; }
  Transcript transcribe(const std::string&, const std::string&) override { return {}; }
};

}
