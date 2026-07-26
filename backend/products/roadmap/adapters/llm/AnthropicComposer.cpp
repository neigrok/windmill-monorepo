#include "products/roadmap/adapters/llm/AnthropicComposer.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <trantor/net/InetAddress.h>
#include <trantor/net/Resolver.h>
#include <trantor/net/TLSPolicy.h>
#include <trantor/net/TcpClient.h>
#include <trantor/utils/MsgBuffer.h>

#include <json/json.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <memory>
#include <utility>

namespace wm {

namespace {

// The load-bearing artifact: the output contract the model rewrites into. It restates the
// paste-import grammar (spec §03) as writing rules, because the client re-parses the reply
// with that grammar verbatim — a plan is only as good as its markdown shape.
constexpr const char* kSystemPrompt =
    "You convert the user's pasted text into a markdown plan. The plan is parsed by a "
    "strict, deterministic grammar, so the shape of the markdown is the whole job.\n"
    "\n"
    "Format:\n"
    "- The first line is `# <goal title>` — the goal of the whole plan. If the text names "
    "no goal, invent a short, honest one from what the text is about.\n"
    "- Group steps under `## <branch>` headings when the content has natural groupings "
    "(2-4 branches). When it doesn't, use no branch headings at all.\n"
    "- Each step is one line. Use `- ` bullets for parallel work that can happen in any "
    "order. Use `1.` `2.` `3.` numbered lists for ordered work where each step unlocks "
    "the next.\n"
    "- Indent a step by 2 spaces under the step above it only when it genuinely depends "
    "on that step being done first. Depth means dependency — never indent for looks.\n"
    "- Write `- [x]` only for steps the text says are already done. Everything else is a "
    "plain step — never guess at completion.\n"
    "- Keep step labels short imperatives, at most 8 words.\n"
    "- Anything that is context rather than a step — links, asides, half sentences — "
    "stays as a plain line (no bullet, no number) directly under the step it belongs to.\n"
    "- A plan is 5 to 40 steps. Short notes keep everything that matters; a long document is "
    "distilled to the work it implies, and prose that only explains or restates is left behind. "
    "Someone should be able to act on the plan without reading the source.\n"
    "\n"
    "Hard rules:\n"
    "- Never invent steps the text does not imply.\n"
    "- Never add commentary, preamble, explanations, or code fences.\n"
    "- Output the plan text and nothing else.";

constexpr const char* kAnthropicHost = "api.anthropic.com";
constexpr double kStreamDeadlineSeconds = 90.0;

std::string messagesPayload(const std::string& text, bool stream) {
  Json::Value message(Json::objectValue);
  message["role"] = "user";
  message["content"] = text;
  Json::Value body(Json::objectValue);
  // Haiku, because shaping is a latency feature before it is a quality one — the plan lands in
  // the well while you are still looking at it, and it does not lead with a thinking block that
  // spends the token budget before the first word of the plan reaches the client.
  body["model"] = "claude-haiku-4-5-20251001";
  // Room for a plan drawn from a long document. The old 2000 was under what a real page of notes
  // produces, and a truncated plan is refused outright — so the budget being tight read to the
  // client as an open stream that never said anything.
  body["max_tokens"] = 8000;
  body["system"] = kSystemPrompt;
  body["messages"] = Json::Value(Json::arrayValue);
  body["messages"].append(message);
  if (stream) body["stream"] = true;

  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, body);
}

// One live streaming call, pinned to the composer's loop thread: resolve → TLS connect →
// write the request → feed every arriving byte to the parser. self is the deliberate
// anchor that keeps the call alive until it settles; every callback holds only a weak
// reference, so hangUp() is the single place the call ends — it releases the anchor on a
// fresh loop tick because tearing the TcpClient down inside its own callback is unsafe.
struct StreamCall : public std::enable_shared_from_this<StreamCall> {
  trantor::EventLoop* loop = nullptr;
  std::string request;
  std::shared_ptr<trantor::Resolver> resolver;
  std::shared_ptr<trantor::TcpClient> client;
  std::unique_ptr<AnthropicStreamParser> parser;
  std::shared_ptr<StreamCall> self;
  bool settled = false;

  void hangUp() {
    if (settled) return;
    settled = true;
    if (client) client->disconnect();
    loop->queueInLoop([anchor = std::move(self), client = std::move(client)]() {});
  }

  void open(const trantor::InetAddress& address) {
    client = std::make_shared<trantor::TcpClient>(loop, address, "anthropic-sse");
    client->enableSSL(trantor::TLSPolicy::defaultClientPolicy(kAnthropicHost));
    std::weak_ptr<StreamCall> weak = weak_from_this();
    client->setConnectionCallback([weak](const trantor::TcpConnectionPtr& connection) {
      auto call = weak.lock();
      if (!call || call->settled) return;
      if (connection->connected()) {
        connection->send(call->request);
        return;
      }
      call->parser->finish();  // upstream hung up before message_stop
    });
    client->setConnectionErrorCallback([weak]() {
      auto call = weak.lock();
      if (!call || call->settled) return;
      LOG_ERROR << "compose stream could not reach upstream";
      call->parser->finish();
    });
    client->setSSLErrorCallback([weak](trantor::SSLError) {
      auto call = weak.lock();
      if (!call || call->settled) return;
      LOG_ERROR << "compose stream TLS handshake failed";
      call->parser->finish();
    });
    client->setMessageCallback([weak](const trantor::TcpConnectionPtr&, trantor::MsgBuffer* buffer) {
      auto call = weak.lock();
      if (call && !call->settled) call->parser->feed(buffer->peek(), buffer->readableBytes());
      buffer->retrieveAll();
    });
    client->connect();
  }
};

}

std::string strippedPlan(const std::string& reply) {
  const auto trimmed = [](const std::string& s) {
    const std::size_t begin = s.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) return std::string();
    const std::size_t end = s.find_last_not_of(" \t\r\n");
    return s.substr(begin, end - begin + 1);
  };

  std::string plan = trimmed(reply);
  if (plan.rfind("```", 0) == 0) {
    const std::size_t firstBreak = plan.find('\n');
    plan = firstBreak == std::string::npos ? std::string() : plan.substr(firstBreak + 1);
  }
  const std::size_t lastBreak = plan.find_last_of('\n');
  const std::string lastLine = lastBreak == std::string::npos ? plan : plan.substr(lastBreak + 1);
  if (trimmed(lastLine) == "```") {
    plan = lastBreak == std::string::npos ? std::string() : plan.substr(0, lastBreak);
  }
  return trimmed(plan);
}

AnthropicStreamParser::AnthropicStreamParser(std::function<void(const std::string&)> onDelta,
                                             std::function<void(bool)> onDone, Reporter onFailure)
    : onDelta_(std::move(onDelta)), onDone_(std::move(onDone)), onFailure_(std::move(onFailure)) {}

void AnthropicStreamParser::feed(const char* data, std::size_t length) {
  if (phase_ == Phase::Done) return;
  raw_.append(data, length);
  while (phase_ != Phase::Done) {
    if (phase_ == Phase::Headers) {
      if (!consumeHeaders()) return;
      continue;
    }
    if (phase_ == Phase::PlainBody) {
      const std::string body = std::move(raw_);
      raw_.clear();
      consumeSse(body.data(), body.size());
      return;
    }
    if (phase_ == Phase::ChunkSize) {
      const std::size_t lineEnd = raw_.find("\r\n");
      if (lineEnd == std::string::npos) return;
      chunkLeft_ = std::strtoul(raw_.c_str(), nullptr, 16);
      raw_.erase(0, lineEnd + 2);
      if (chunkLeft_ == 0) {
        settle(false);  // body over without a message_stop: a broken, not finished, reply
        return;
      }
      phase_ = Phase::ChunkData;
      continue;
    }
    if (phase_ == Phase::ChunkData) {
      if (raw_.empty()) return;
      const std::size_t take = std::min(chunkLeft_, raw_.size());
      consumeSse(raw_.data(), take);
      raw_.erase(0, take);
      chunkLeft_ -= take;
      if (chunkLeft_ == 0) phase_ = phase_ == Phase::Done ? Phase::Done : Phase::ChunkGap;
      continue;
    }
    if (raw_.size() < 2) return;  // ChunkGap: the \r\n that closes every chunk
    raw_.erase(0, 2);
    phase_ = Phase::ChunkSize;
  }
}

void AnthropicStreamParser::finish() { settle(false); }

void AnthropicStreamParser::settle(bool ok) {
  if (phase_ == Phase::Done) return;
  phase_ = Phase::Done;
  onDone_(ok);
}

bool AnthropicStreamParser::consumeHeaders() {
  const std::size_t end = raw_.find("\r\n\r\n");
  if (end == std::string::npos) return false;
  std::string head = raw_.substr(0, end);
  raw_.erase(0, end + 4);
  for (char& c : head) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  const std::size_t space = head.find(' ');
  const int status = space == std::string::npos ? 0 : std::atoi(head.c_str() + space + 1);
  if (status != 200) {
    LOG_ERROR << "compose stream upstream answered status " << status;
    settle(false);
    return false;
  }
  // RFC 7230 permits `transfer-encoding:chunked`, extra whitespace, or a list — look for
  // the token anywhere in that header's line rather than one exact byte sequence.
  bool chunked = false;
  const std::size_t te = head.find("transfer-encoding:");
  if (te != std::string::npos) {
    const std::size_t eol = head.find("\r\n", te);
    chunked = head.substr(te, eol == std::string::npos ? std::string::npos : eol - te)
                  .find("chunked") != std::string::npos;
  }
  phase_ = chunked ? Phase::ChunkSize : Phase::PlainBody;
  return true;
}

void AnthropicStreamParser::consumeSse(const char* data, std::size_t length) {
  sse_.append(data, length);
  std::size_t start = 0;
  while (phase_ != Phase::Done) {
    const std::size_t lineEnd = sse_.find('\n', start);
    if (lineEnd == std::string::npos) break;
    std::string line = sse_.substr(start, lineEnd - start);
    start = lineEnd + 1;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) {
      dispatch(eventName_, eventData_);
      eventName_.clear();
      eventData_.clear();
      continue;
    }
    if (line.front() == ':') continue;  // heartbeat comment
    if (line.rfind("event:", 0) == 0) {
      eventName_ = line.substr(line.size() > 6 && line[6] == ' ' ? 7 : 6);
      continue;
    }
    if (line.rfind("data:", 0) == 0) {
      if (!eventData_.empty()) eventData_ += '\n';
      eventData_ += line.substr(line.size() > 5 && line[5] == ' ' ? 6 : 5);
    }
  }
  sse_.erase(0, start);
}

void AnthropicStreamParser::dispatch(const std::string& event, const std::string& data) {
  if (event == "message_stop") {
    // Any early stop — max_tokens truncation above all — fails; a cut-off plan must never
    // masquerade as a finished one. Deltas already forwarded stay with the client. This is the
    // quiet one: the user waited, saw a plan begin (or not), and got a refusal. Say so out loud.
    if (stopReason_ != "end_turn" && onFailure_)
      onFailure_("compose.stream", "stopped early (stop_reason: " +
                                       (stopReason_.empty() ? std::string("missing") : stopReason_) + ")");
    settle(stopReason_ == "end_turn");
    return;
  }
  if (event == "error") {
    if (onFailure_) onFailure_("compose.stream", "upstream error event: " + data);
    LOG_ERROR << "compose stream upstream errored: " << data;
    settle(false);
    return;
  }
  if (event != "content_block_delta" && event != "message_delta") return;

  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value payload;
  std::string errors;
  if (!reader->parse(data.data(), data.data() + data.size(), &payload, &errors) ||
      !payload.isObject()) {
    if (onFailure_) onFailure_("compose.stream", "unreadable " + event + " frame");
    LOG_ERROR << "compose stream upstream sent an unreadable " << event << " frame";
    settle(false);
    return;
  }
  const Json::Value& delta = payload["delta"];
  if (event == "message_delta") {
    if (delta["stop_reason"].isString()) stopReason_ = delta["stop_reason"].asString();
    return;
  }
  // Only text deltas leave the adapter; thinking deltas and signatures stay behind the seam.
  if (delta["type"].asString() == "text_delta" && delta["text"].isString()) {
    onDelta_(delta["text"].asString());
  }
}

AnthropicComposer::AnthropicComposer(std::string apiKey, std::shared_ptr<FailureReporter> failures)
    : apiKey_(std::move(apiKey)), failures_(std::move(failures)) {
  loop_.run();
}

AnthropicStreamParser::Reporter AnthropicComposer::reporter() const {
  return [failures = failures_](const std::string& where, const std::string& detail) {
    LOG_ERROR << where << ": " << detail;
    if (failures) failures->report("compose", where, detail);
  };
}

bool AnthropicComposer::configured() const { return !apiKey_.empty(); }

void AnthropicComposer::compose(const std::string& text,
                                std::function<void(std::optional<std::string>)> done) {
  if (apiKey_.empty()) {
    done(std::nullopt);
    return;
  }

  auto client = drogon::HttpClient::newHttpClient("https://api.anthropic.com", loop_.getLoop());

  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(drogon::Post);
  req->setPath("/v1/messages");
  req->addHeader("x-api-key", apiKey_);
  req->addHeader("anthropic-version", "2023-06-01");
  req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  req->setBody(messagesPayload(text, false));

  client->sendRequest(
      req,
      [client, report = reporter(), done = std::move(done)](drogon::ReqResult result, const drogon::HttpResponsePtr& resp) {
        const int status = resp ? static_cast<int>(resp->getStatusCode()) : 0;
        if (result != drogon::ReqResult::Ok || status < 200 || status >= 300) {  // accept any 2xx
          const std::string detail = resp ? std::string(resp->getBody()) : std::string("no response");
          LOG_ERROR << "compose upstream failed (status " << status << "): " << detail;
          done(std::nullopt);
          return;
        }

        std::shared_ptr<Json::Value> reply = resp->getJsonObject();
        if (!reply || !(*reply)["content"].isArray() || (*reply)["content"].empty()) {
          report("compose.buffered", "unreadable reply");
          done(std::nullopt);
          return;
        }

        // Sonnet-class models lead with a thinking block; the plan is the first TEXT block.
        std::string raw;
        for (const Json::Value& block : (*reply)["content"]) {
          if (block["text"].isString()) { raw = block["text"].asString(); break; }
        }
        if (raw.empty()) {
          report("compose.buffered", "reply carried no text block");
          done(std::nullopt);
          return;
        }

        const Json::Value& stopReason = (*reply)["stop_reason"];
        if (!stopReason.isString() || stopReason.asString() != "end_turn") {
          // max_tokens or any other early stop means a truncated plan — never hand the
          // client half a plan to replace the user's paste with.
          report("compose.buffered", "stopped early (stop_reason: " +
                                                 (stopReason.isString() ? stopReason.asString() : std::string("missing")) + ")");
          done(std::nullopt);
          return;
        }

        const std::string plan = strippedPlan(raw);
        if (plan.empty()) {
          done(std::nullopt);
          return;
        }
        done(plan);
      },
      40.0);  // Sonnet thinks before it writes; the call holds no handler thread, so give it room
}

std::function<void()> AnthropicComposer::composeStream(
    const std::string& text,
    std::function<void(const std::string&)> onDelta,
    std::function<void(bool)> onDone) {
  if (apiKey_.empty()) {
    onDone(false);
    return []() {};
  }

  // drogon's HttpClient buffers the whole upstream reply before its callback, so the
  // streaming leg speaks HTTP/1.1 itself over a raw trantor TLS connection and decodes
  // the SSE reply byte-by-byte as it arrives.
  const std::string payload = messagesPayload(text, true);
  std::string request;
  request += "POST /v1/messages HTTP/1.1\r\n";
  request += std::string("Host: ") + kAnthropicHost + "\r\n";
  request += "x-api-key: " + apiKey_ + "\r\n";
  request += "anthropic-version: 2023-06-01\r\n";
  request += "content-type: application/json\r\n";
  request += "accept: text/event-stream\r\n";
  request += "connection: close\r\n";
  request += "content-length: " + std::to_string(payload.size()) + "\r\n";
  request += "\r\n";
  request += payload;

  auto call = std::make_shared<StreamCall>();
  call->loop = loop_.getLoop();
  call->request = std::move(request);
  call->self = call;
  std::weak_ptr<StreamCall> weak = call;
  // The reporter holds the shared_ptr, not `this`: a stream can settle long after the caller has
  // gone, and a report must never reach through a dangling composer to get out.
  call->parser = std::make_unique<AnthropicStreamParser>(
      std::move(onDelta),
      [weak, onDone = std::move(onDone)](bool ok) {
        if (auto call = weak.lock()) call->hangUp();
        onDone(ok);
      },
      reporter());

  call->loop->runInLoop([call, weak]() {
    if (call->settled) return;
    call->resolver = trantor::Resolver::newResolver(call->loop);
    call->resolver->resolve(kAnthropicHost, [weak](const trantor::InetAddress& resolved) {
      auto outer = weak.lock();
      if (!outer) return;
      // The resolver may answer from a helper thread; hop back onto the call's loop.
      outer->loop->runInLoop([weak, resolved]() {
        auto call = weak.lock();
        if (!call || call->settled) return;
        if (resolved.isUnspecified() || resolved.toIp() == "0.0.0.0") {
          LOG_ERROR << "compose stream could not resolve upstream";
          call->parser->finish();
          return;
        }
        call->open(trantor::InetAddress(resolved.toIp(), 443, resolved.isIpV6()));
      });
    });
    call->loop->runAfter(kStreamDeadlineSeconds, [weak]() {
      auto call = weak.lock();
      if (!call || call->settled) return;
      LOG_ERROR << "compose stream hit the " << kStreamDeadlineSeconds << "s deadline";
      call->parser->finish();
    });
  });

  return [weak]() {
    auto outer = weak.lock();
    if (!outer) return;
    outer->loop->runInLoop([weak]() {
      if (auto call = weak.lock()) call->hangUp();
    });
  };
}

}
