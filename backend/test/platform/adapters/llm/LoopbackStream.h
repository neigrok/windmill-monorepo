#pragma once

#include "platform/adapters/json/JsonText.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

namespace wm::test {

// A Messages vendor on loopback that streams one reply: the message start, reporting `inputTokens`, then the text
// `delta` every `gap`, until the client hangs up or `deltas` have gone, when it finishes the message as vendors do. A
// client that has not come within ten seconds is not waited for.
class LoopbackStream {
public:
  LoopbackStream(long long inputTokens, std::string delta, int deltas, std::chrono::milliseconds gap)
      : listener_(::socket(AF_INET, SOCK_STREAM, 0)) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t size = sizeof(address);
    if (listener_ < 0 || ::bind(listener_, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0 ||
        ::getsockname(listener_, reinterpret_cast<sockaddr*>(&address), &size) != 0 || ::listen(listener_, 1) != 0)
      throw std::runtime_error("loopback stream could not listen");
    port_ = ntohs(address.sin_port);
    server_ = std::thread([this, inputTokens, delta = std::move(delta), deltas, gap] {
      pollfd waiting{listener_, POLLIN, 0};
      if (::poll(&waiting, 1, 10'000) != 1) return;
      const int peer = ::accept(listener_, nullptr, nullptr);
      if (peer < 0) return;
#ifdef SO_NOSIGPIPE
      const int on = 1;
      ::setsockopt(peer, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));
#endif
      readRequest(peer);
      Json::Value start = parse(R"({"type":"message_start","message":{"id":"msg","type":"message","role":"assistant",
          "content":[],"usage":{"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}})");
      start["message"]["usage"]["input_tokens"] = static_cast<Json::Int64>(inputTokens);
      Json::Value text = parse(R"({"type":"content_block_delta","index":0,"delta":{"type":"text_delta"}})");
      text["delta"]["text"] = delta;
      bool open = write(peer, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n") &&
          write(peer, event(start)) &&
          write(peer, event(parse(R"({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})")));
      for (int index = 0; open && index < deltas; ++index) {
        open = write(peer, event(text));
        if (open) ++sent_;
        std::this_thread::sleep_for(gap);
      }
      if (open) {
        write(peer, event(parse(R"({"type":"content_block_stop","index":0})")));
        write(peer, event(parse(R"({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1500}})")));
        write(peer, event(parse(R"({"type":"message_stop"})")));
      }
      ::close(peer);
    });
  }

  ~LoopbackStream() {
    if (server_.joinable()) server_.join();
    if (listener_ >= 0) ::close(listener_);
  }

  LoopbackStream(const LoopbackStream&) = delete;
  LoopbackStream& operator=(const LoopbackStream&) = delete;

  std::string baseUrl() const { return "http://127.0.0.1:" + std::to_string(port_); }
  // The deltas that went out before the client hung up.
  int sent() const { return sent_.load(); }

private:
  static std::string event(const Json::Value& payload) { return "event: vendor\r\ndata: " + dump(payload) + "\r\n\r\n"; }

  static bool write(int peer, const std::string& bytes) {
#ifdef MSG_NOSIGNAL
    const int flags = MSG_NOSIGNAL;
#else
    const int flags = 0;
#endif
    return ::send(peer, bytes.data(), bytes.size(), flags) == static_cast<ssize_t>(bytes.size());
  }

  // Through the end of the body; a client that asks to be told to go on is told so.
  static void readRequest(int peer) {
    std::string request;
    char buffer[16 * 1024];
    bool continued = false;
    for (;;) {
      const auto read = ::recv(peer, buffer, sizeof(buffer), 0);
      if (read <= 0) return;
      request.append(buffer, static_cast<std::size_t>(read));
      const auto headers = request.find("\r\n\r\n");
      if (headers == std::string::npos) continue;
      if (!continued && request.find("100-continue") < headers) {
        continued = true;
        write(peer, "HTTP/1.1 100 Continue\r\n\r\n");
      }
      const auto length = request.find("Content-Length:");
      const auto body = length == std::string::npos ? 0 : std::stoull(request.substr(length + 15));
      if (request.size() >= headers + 4 + body) return;
    }
  }

  int listener_;
  int port_ = 0;
  std::atomic<int> sent_{0};
  std::thread server_;
};

}
