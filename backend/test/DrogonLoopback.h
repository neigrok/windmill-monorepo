#pragma once

#include <drogon/HttpAppFramework.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

namespace wm::test {

// Drogon listening on loopback in this process, so a test sends a request's bytes and gets back the request Drogon's
// own parser made of them. Each request it hands over is answered with the response the test chose; one Drogon
// refuses never reaches a test, which reads the refusal instead. Started on first use, stopped when the process ends.
class DrogonLoopback {
public:
  using Respond = std::function<drogon::HttpResponsePtr(const drogon::HttpRequestPtr&)>;

  // What one request's bytes came to: the whole answer as it crossed the wire, and the request Drogon handed over, or
  // null when it answered without handing one over.
  struct Exchange {
    std::string answer;
    drogon::HttpRequestPtr request;
  };

  static DrogonLoopback& instance() {
    static DrogonLoopback loopback;
    return loopback;
  }

  ~DrogonLoopback() {
    drogon::app().quit();
    runner_.join();
  }

  static drogon::HttpResponsePtr noContent(const drogon::HttpRequestPtr&) {
    auto response = drogon::HttpResponse::newHttpResponse();
    response->setStatusCode(drogon::k204NoContent);
    return response;
  }

  // One client connection, kept alive across the requests sent on it.
  class Connection {
  public:
    Connection() : loopback_(instance()), fd_(::socket(AF_INET, SOCK_STREAM, 0)) {
      const sockaddr_in address = loopback_.address();
      for (int attempt = 0; ::connect(fd_, reinterpret_cast<const sockaddr*>(&address), sizeof address) != 0; ++attempt) {
        if (attempt == 100) throw std::runtime_error("the loopback listener never took a connection");
        ::close(fd_);
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
      }
    }
    ~Connection() { ::close(fd_); }
    Connection(const Connection&) = delete;
    Connection& operator=(const Connection&) = delete;

    // Sends `bytes`, one whole request, and reads the whole answer: a 100 Continue and the response after it, framed
    // by its Content-Length.
    Exchange exchange(const std::string& bytes, Respond respond = noContent) {
      loopback_.respondWith(std::move(respond));
      for (std::size_t sent = 0; sent < bytes.size();) {
        const ssize_t wrote = ::send(fd_, bytes.data() + sent, bytes.size() - sent, 0);
        if (wrote <= 0) throw std::runtime_error("the loopback connection closed mid-request");
        sent += static_cast<std::size_t>(wrote);
      }
      std::string answer;
      while (!whole(answer)) {
        char buffer[4096];
        const ssize_t read = ::recv(fd_, buffer, sizeof buffer, 0);
        if (read <= 0) throw std::runtime_error("the loopback connection closed before its answer: " + answer);
        answer.append(buffer, static_cast<std::size_t>(read));
      }
      return Exchange{answer, loopback_.handedOver()};
    }

  private:
    static bool whole(const std::string& answer) {
      std::size_t head = answer.find("\r\n\r\n");
      if (head != std::string::npos && answer.starts_with("HTTP/1.1 100")) head = answer.find("\r\n\r\n", head + 4);
      if (head == std::string::npos) return false;
      const std::size_t length = answer.find("content-length: ");
      const std::size_t body = length == std::string::npos || length > head ? 0 : std::stoul(answer.substr(length + 16));
      return answer.size() >= head + 4 + body;
    }

    DrogonLoopback& loopback_;
    int fd_;
  };

private:
  DrogonLoopback() : port_(freePort()) {
    drogon::app()
        .setDefaultHandler([this](const drogon::HttpRequestPtr& req, std::function<void(const drogon::HttpResponsePtr&)>&& answer) {
          Respond respond;
          {
            std::lock_guard lock(mutex_);
            handedOver_.push_back(req);
            respond = respond_;
          }
          answer(respond(req));
        })
        .addListener("127.0.0.1", port_)
        .setThreadNum(1)
        .setClientMaxBodySize(8 * 1024 * 1024)
        .setClientMaxMemoryBodySize(8 * 1024 * 1024)
        .setUploadPath((std::filesystem::temp_directory_path() / "windmill-drogon-loopback").string())
        .setLogLevel(trantor::Logger::kWarn)
        .disableSigtermHandling();
    runner_ = std::thread([] { drogon::app().run(); });
  }

  static std::uint16_t freePort() {
    const int probe = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t length = sizeof address;
    ::bind(probe, reinterpret_cast<const sockaddr*>(&address), sizeof address);
    ::getsockname(probe, reinterpret_cast<sockaddr*>(&address), &length);
    ::close(probe);
    return ntohs(address.sin_port);
  }

  sockaddr_in address() const {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(port_);
    return address;
  }

  void respondWith(Respond respond) {
    std::lock_guard lock(mutex_);
    respond_ = std::move(respond);
  }

  drogon::HttpRequestPtr handedOver() {
    std::lock_guard lock(mutex_);
    if (handedOver_.empty()) return nullptr;
    drogon::HttpRequestPtr req = std::move(handedOver_.front());
    handedOver_.pop_front();
    return req;
  }

  std::uint16_t port_;
  std::thread runner_;
  std::mutex mutex_;
  Respond respond_ = noContent;
  std::deque<drogon::HttpRequestPtr> handedOver_;
};

}
