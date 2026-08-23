#pragma once

#include "platform/adapters/llm/AnthropicClient.h"
#include "platform/ports/FailureReporter.h"
#include "products/roadmap/ports/PlanComposer.h"

#include <trantor/net/EventLoopThread.h>

#include <cstddef>
#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace wm {

// The prompt forbids code fences, but a model that wraps its reply in them anyway must not leak
// them into the plan the client re-parses: strip a leading ``` / ```markdown line and a trailing
// ``` line, trim the edges, and touch nothing else.
std::string strippedPlan(const std::string& reply);

// Incremental decoder for the streaming Messages reply, fed raw HTTP/1.1 response bytes
// (status line, headers, chunked or plain body) exactly as they land on the socket. Only
// text_delta content reaches onDelta — thinking deltas never leave the adapter. onDone
// fires exactly once: true only for a clean end_turn stop; a non-200 status, a garbled
// frame, a close before message_stop (report via finish), or a truncating stop_reason is
// false. After onDone every further byte is ignored.
class AnthropicStreamParser {
public:
  // onFailure names the reason a stream came apart: an upstream error code, a truncating stop
  // reason.
  using Reporter = std::function<void(const std::string& where, const std::string& detail)>;

  AnthropicStreamParser(std::function<void(const std::string&)> onDelta,
                        std::function<void(bool)> onDone, Reporter onFailure = nullptr);

  void feed(const char* data, std::size_t length);
  void finish();
  bool done() const { return phase_ == Phase::Done; }
  // What the reply's head said, or 0 while none has landed.
  int status() const { return status_; }
  // What the stream has cost so far: the decoder is the only thing that sees `message_start` and
  // `message_delta`. State to be read at the end, never a second callback.
  TokenUse tokens() const { return tokens_; }

private:
  enum class Phase { Headers, ChunkSize, ChunkData, ChunkGap, PlainBody, Done };

  void settle(bool ok);
  bool consumeHeaders();
  void consumeSse(const char* data, std::size_t length);
  void dispatch(const std::string& event, const std::string& data);

  std::function<void(const std::string&)> onDelta_;
  std::function<void(bool)> onDone_;
  Reporter onFailure_;
  Phase phase_ = Phase::Headers;
  int status_ = 0;
  std::string raw_;
  std::size_t chunkLeft_ = 0;
  std::string sse_;
  std::string eventName_;
  std::string eventData_;
  std::string stopReason_;
  TokenUse tokens_;
};

// Composes plans through Anthropic's Messages API: the raw paste rides as the user turn under a
// system prompt that pins the paste grammar. Owns a private event-loop thread that carries the
// outbound HTTPS call, so the server's request loops are never parked waiting on the model.
// compose buffers the whole reply (done fires once it, or the 40s timeout, lands); composeStream
// speaks the wire itself — a raw trantor TLS connection, because drogon's HttpClient only ever
// delivers a fully buffered response — under a 90s whole-stream deadline.
class AnthropicComposer : public PlanComposer {
public:
  // The reporter, the fuse and the sink are all optional (null = do nothing), so tests and local
  // runs stay silent.
  //
  // This seam sits on an UNAUTHENTICATED door: the paste is capped and the fuse is asked before
  // the call, and over either of them the birth canvas falls back to its deterministic parser —
  // never a 503.
  explicit AnthropicComposer(std::string apiKey, std::shared_ptr<FailureReporter> failures = nullptr,
                             std::shared_ptr<AiFuse> fuse = nullptr,
                             std::shared_ptr<UsageSink> usage = nullptr);

  bool configured() const override;
  void compose(const std::string& text,
               std::function<void(std::optional<std::string>)> done) override;
  std::function<void()> composeStream(const std::string& text,
                                      std::function<void(const std::string&)> onDelta,
                                      std::function<void(bool)> onDone) override;

private:
  // The reporter owns everything it needs: a compose call settles long after the caller may be
  // gone, so nothing it holds may reach back through the composer.
  AnthropicStreamParser::Reporter reporter() const;

  std::string apiKey_;
  std::shared_ptr<FailureReporter> failures_;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
  trantor::EventLoopThread loop_;
};

}
