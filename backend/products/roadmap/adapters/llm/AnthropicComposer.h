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

// Strip a leading ``` / ```markdown line and a trailing ``` line, trim the edges, touch nothing else.
std::string strippedPlan(const std::string& reply);

// Incremental decoder for the streaming Messages reply, fed raw HTTP/1.1 response bytes as they land.
// Only text_delta reaches onDelta. onDone fires exactly once, true only for a clean end_turn stop;
// after it every further byte is ignored.
class AnthropicStreamParser {
public:
  using Reporter = std::function<void(const std::string& where, const std::string& detail)>;

  AnthropicStreamParser(std::function<void(const std::string&)> onDelta,
                        std::function<void(bool)> onDone, Reporter onFailure = nullptr);

  void feed(const char* data, std::size_t length);
  void finish();
  bool done() const { return phase_ == Phase::Done; }
  // 0 while no reply head has landed.
  int status() const { return status_; }
  // State to be read at the end, never a second callback.
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

// Composes plans through Anthropic's Messages API, on a private event-loop thread so the server's
// request loops never park on the model. compose buffers the whole reply under a 40s timeout;
// composeStream speaks HTTP/1.1 itself over a raw trantor TLS connection, under a 90s deadline.
class AnthropicComposer : public PlanComposer {
public:
  // The reporter, the fuse and the sink are optional (null = do nothing).
  // This seam sits on an unauthenticated door: the paste is capped and the fuse asked before the call.
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
  // Owns everything it needs: a compose call settles long after the caller may be gone.
  AnthropicStreamParser::Reporter reporter() const;

  std::string apiKey_;
  std::shared_ptr<FailureReporter> failures_;
  std::shared_ptr<AiFuse> fuse_;
  std::shared_ptr<UsageSink> usage_;
  trantor::EventLoopThread loop_;
};

}
