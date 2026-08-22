#pragma once

#include "platform/domain/Ids.h"

#include <functional>
#include <optional>
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
//
// IT ANSWERS THROUGH A CALLBACK, and that is the whole reason this signature exists. The old one
// returned a Transcript, so the handler thread that called it sat on a 60-second vendor round trip:
// N concurrent takes parked N of drogon's handler threads and every other route in the product —
// auth, roadmap, gym, MCP — queued behind them. Measured at 8 concurrent uploads, an unrelated
// GET /v1/me went from 2 ms to 1.5 s. `done` may fire on any thread, including the vendor client's
// own loop, and it fires exactly once.
//
// `nullopt` is a vendor failure, and the difference from an empty transcript is load-bearing: the
// route used to answer 200 {"text":""} either way, so silence and an outage were the same reply.
//
// `user` is here because this seam SPENDS. An implementation meters the call against that account's
// ledger and the process fuse (platform/adapters/llm/AnthropicClient.h, meterSpend), the same way
// the curator does; nothing here reads it back.
struct Transcriber {
  virtual ~Transcriber() = default;
  virtual bool configured() const = 0;
  virtual void transcribe(const UserId& user, const std::string& audio, const std::string& mimeType,
                          std::function<void(std::optional<Transcript>)> done) = 0;
};

}
