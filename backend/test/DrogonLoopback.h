#pragma once

#include <drogon/HttpAppFramework.h>
#include <drogon/WebSocketController.h>
#include <drogon/utils/Utilities.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <chrono>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace wm::test {

// Drogon listening on loopback in this process, so a test sends a request's bytes and gets back the request Drogon's
// own parser made of them. Each request it hands over is answered with the response the test chose, or by the route
// the test gave it, as a handler would; one Drogon refuses never reaches a test, which reads the refusal instead. The
// test main stops it before static destruction.
class DrogonLoopback {
public:
  using Answer = std::function<void(const drogon::HttpResponsePtr&)>;
  using Respond = std::function<drogon::HttpResponsePtr(const drogon::HttpRequestPtr&)>;
  // A handler as Drogon calls one: it answers when it is ready, on any thread.
  using Route = std::function<void(const drogon::HttpRequestPtr&, Answer&&)>;

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

  static void stopExisting() {
    if (existing_) existing_->stop();
  }

  ~DrogonLoopback() {
    stop();
    existing_ = nullptr;
  }

  void stop() {
    if (!runner_.joinable()) return;
    drogon::app().quit();
    runner_.join();
  }

  static drogon::HttpResponsePtr noContent(const drogon::HttpRequestPtr&) {
    auto response = drogon::HttpResponse::newHttpResponse();
    response->setStatusCode(drogon::k204NoContent);
    return response;
  }

  // The request Drogon parses from `method target`, `fields`, each a whole field line, and `body`, sent on a connection of
  // its own. It travels under /loopback, a path no route a test registers on the app answers, so the loopback hands it
  // over, and it carries its own path.
  static drogon::HttpRequestPtr received(std::string_view method, const std::string& target, const std::vector<std::string>& fields,
                                         std::string_view body = "") {
    constexpr std::string_view under = "/loopback";
    std::string bytes = std::string(method) + " " + std::string(under) + target + " HTTP/1.1\r\n";
    for (const std::string& field : fields) bytes += field + "\r\n";
    bytes += "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n" + std::string(body);
    Connection connection;
    Exchange exchange = connection.exchange(bytes);
    if (!exchange.request) throw std::runtime_error("Drogon answered the request without handing it over: " + exchange.answer);
    exchange.request->setPath(exchange.request->path().substr(under.size()));
    return exchange.request;
  }

  // The request Drogon parses from `built`, one a test assembled: its method, path, query, every header field, its cookies
  // on one Cookie line, its JSON, form, text or PNG content type, its body, and, when it has no body, its parameters. Every
  // door reads a request's credentials from the lines it was received with, which only a request Drogon parsed carries;
  // one it parsed already is answered as it is.
  static drogon::HttpRequestPtr received(const drogon::HttpRequestPtr& built) {
    if (!built->headerOccurrences().empty()) return built;
    std::string target = built->path().empty() ? "/" : built->path();
    std::string query = built->query();
    // A built request with a body reads that body as form parameters, so only a bodiless one's parameters are its own.
    if (built->body().empty())
      for (const auto& [name, value] : built->getParameters())
        query += (query.empty() ? "" : "&") + drogon::utils::urlEncodeComponent(name) + "=" + drogon::utils::urlEncodeComponent(value);
    if (!query.empty()) target += "?" + query;
    std::vector<std::string> fields;
    if (built->getHeader("host").empty()) fields.push_back("Host: localhost");
    for (const auto& [name, value] : built->headers())
      if (name != "content-length") fields.push_back(name + ": " + value);
    std::string cookies;
    for (const auto& [name, value] : built->cookies()) cookies += (cookies.empty() ? "" : "; ") + name + "=" + value;
    if (!cookies.empty()) fields.push_back("Cookie: " + cookies);
    if (built->getHeader("content-type").empty()) {
      if (built->contentType() == drogon::CT_APPLICATION_JSON) fields.push_back("Content-Type: application/json");
      if (built->contentType() == drogon::CT_APPLICATION_X_FORM) fields.push_back("Content-Type: application/x-www-form-urlencoded");
      if (built->contentType() == drogon::CT_TEXT_PLAIN) fields.push_back("Content-Type: text/plain");
      if (built->contentType() == drogon::CT_IMAGE_PNG) fields.push_back("Content-Type: image/png");
    }
    return received(built->methodString(), target, fields, built->body());
  }

  // One client connection, kept alive across the requests sent on it. A read waits at most 30 s for its next bytes.
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
      const timeval readBound{30, 0};
      ::setsockopt(fd_, SOL_SOCKET, SO_RCVTIMEO, &readBound, sizeof readBound);
    }
    ~Connection() { ::close(fd_); }
    Connection(const Connection&) = delete;
    Connection& operator=(const Connection&) = delete;

    // Sends `bytes`, one whole request, and reads the whole answer: a 100 Continue and the response after it, framed
    // by its Content-Length.
    Exchange exchange(const std::string& bytes, Respond respond = noContent) {
      return exchange(bytes, [respond = std::move(respond)](const drogon::HttpRequestPtr& req, Answer&& answer) {
        answer(respond(req));
      });
    }

    Exchange exchange(const std::string& bytes, Route route) {
      loopback_.routeTo(std::move(route));
      for (std::size_t sent = 0; sent < bytes.size();) {
        const ssize_t wrote = ::send(fd_, bytes.data() + sent, bytes.size() - sent, 0);
        if (wrote <= 0) throw std::runtime_error("the loopback connection closed mid-request");
        sent += static_cast<std::size_t>(wrote);
      }
      std::string answer;
      while (!whole(answer)) {
        char buffer[4096];
        const ssize_t read = ::recv(fd_, buffer, sizeof buffer, 0);
        if (read == 0) throw std::runtime_error("the loopback connection closed before its answer: " + answer);
        if (read < 0) throw std::runtime_error("the loopback connection read nothing more for 30 s: " + answer);
        answer.append(buffer, static_cast<std::size_t>(read));
      }
      return Exchange{answer, loopback_.handedOver()};
    }

    // Upgrades this connection to a WebSocket on /socket and answers the server's end of it. The client end reads
    // nothing more until `take` is called.
    drogon::WebSocketConnectionPtr upgrade() {
      std::future<drogon::WebSocketConnectionPtr> opened = loopback_.nextSocket();
      const std::string request = "GET /socket HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                                  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
      if (::send(fd_, request.data(), request.size(), 0) != static_cast<ssize_t>(request.size()))
        throw std::runtime_error("the loopback connection closed mid-upgrade");
      std::string head;
      while (head.find("\r\n\r\n") == std::string::npos) {
        char byte;
        if (::recv(fd_, &byte, 1, 0) != 1) throw std::runtime_error("the loopback connection closed before its upgrade: " + head);
        head.push_back(byte);
      }
      if (!head.starts_with("HTTP/1.1 101")) throw std::runtime_error("the upgrade was refused: " + head);
      if (opened.wait_for(std::chrono::seconds(10)) != std::future_status::ready)
        throw std::runtime_error("the server never opened the socket");
      return opened.get();
    }

    // Reads from the client end until `bytes` have arrived, and answers how many did.
    std::size_t take(std::size_t bytes) {
      std::size_t taken = 0;
      std::string buffer(256 * 1024, '\0');
      while (taken < bytes) {
        const ssize_t read = ::recv(fd_, buffer.data(), buffer.size(), 0);
        if (read <= 0) throw std::runtime_error("the loopback connection closed while its messages were read");
        taken += static_cast<std::size_t>(read);
      }
      return taken;
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
  // The server's end of each socket opened on /socket, handed to the test that asked for the next one.
  class Sockets : public drogon::WebSocketController<Sockets, false> {
  public:
    explicit Sockets(DrogonLoopback& loopback) : loopback_(loopback) {}
    void handleNewMessage(const drogon::WebSocketConnectionPtr&, std::string&&, const drogon::WebSocketMessageType&) override {}
    void handleNewConnection(const drogon::HttpRequestPtr&, const drogon::WebSocketConnectionPtr& conn) override {
      std::lock_guard lock(loopback_.mutex_);
      if (loopback_.awaitedSocket_) loopback_.awaitedSocket_->set_value(conn);
      loopback_.awaitedSocket_.reset();
    }
    void handleConnectionClosed(const drogon::WebSocketConnectionPtr&) override {}
    WS_PATH_LIST_BEGIN
    WS_PATH_ADD("/socket");
    WS_PATH_LIST_END

  private:
    DrogonLoopback& loopback_;
  };

  std::future<drogon::WebSocketConnectionPtr> nextSocket() {
    std::lock_guard lock(mutex_);
    awaitedSocket_.emplace();
    return awaitedSocket_->get_future();
  }

  DrogonLoopback() : port_(freePort()) {
    drogon::app().registerController(std::make_shared<Sockets>(*this));
    drogon::app()
        .setDefaultHandler([this](const drogon::HttpRequestPtr& req, Answer&& answer) {
          Route route;
          {
            std::lock_guard lock(mutex_);
            handedOver_.push_back(req);
            route = route_;
          }
          route(req, std::move(answer));
        })
        .addListener("127.0.0.1", port_)
        .setThreadNum(1)
        .setClientMaxBodySize(8 * 1024 * 1024)
        .setClientMaxMemoryBodySize(8 * 1024 * 1024)
        .setUploadPath((std::filesystem::temp_directory_path() / "windmill-drogon-loopback").string())
        .setLogLevel(trantor::Logger::kWarn)
        .disableSigtermHandling();
    runner_ = std::thread([] { drogon::app().run(); });
    existing_ = this;
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

  void routeTo(Route route) {
    std::lock_guard lock(mutex_);
    route_ = std::move(route);
  }

  drogon::HttpRequestPtr handedOver() {
    std::lock_guard lock(mutex_);
    if (handedOver_.empty()) return nullptr;
    drogon::HttpRequestPtr req = std::move(handedOver_.front());
    handedOver_.pop_front();
    return req;
  }

  inline static DrogonLoopback* existing_ = nullptr;
  std::uint16_t port_;
  std::thread runner_;
  std::mutex mutex_;
  Route route_ = [](const drogon::HttpRequestPtr& req, Answer&& answer) { answer(noContent(req)); };
  std::deque<drogon::HttpRequestPtr> handedOver_;
  std::optional<std::promise<drogon::WebSocketConnectionPtr>> awaitedSocket_;
};

}
