#include "platform/adapters/http/TappedListener.h"

#include "platform/adapters/http/CredentialTap.h"

#include <trantor/net/EventLoop.h>
#include <trantor/net/InetAddress.h>
#include <trantor/net/TcpClient.h>
#include <trantor/net/TcpConnection.h>
#include <trantor/net/TcpServer.h>
#include <trantor/utils/Logger.h>
#include <trantor/utils/MsgBuffer.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <memory>
#include <stdexcept>
#include <string_view>

namespace wm {

namespace {

#ifdef __linux__
constexpr bool kDrogonHandsOverConnections = true;
#else
constexpr bool kDrogonHandsOverConnections = false;
#endif

constexpr std::string_view kRefused = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

void refuse(const trantor::TcpConnectionPtr& conn) {
  conn->send(kRefused.data(), kRefused.size());
  conn->shutdown();
}

// trantor keeps a connection's reader where only a TcpConnection may name it: this names Drogon's, which the tap wraps.
struct DrogonReader : trantor::TcpConnection {
  static trantor::RecvMessageCallback of(trantor::TcpConnection& conn) { return conn.*(&DrogonReader::recvMsgCallback_); }
};

// Each connection Drogon accepts reads through its own tap, into a buffer Drogon's reader parses. The callback runs
// before the connection reads its first byte, so no request escapes the tap.
void tapDrogonReaders(drogon::HttpAppFramework& app) {
  app.setConnectionCallback([](const trantor::TcpConnectionPtr& conn) {
    if (!conn->connected()) return;
    const trantor::RecvMessageCallback drogonReads = DrogonReader::of(*conn);
    if (!drogonReads) {
      LOG_ERROR << "credential tap: a connection with no reader to wrap; the sync endpoints answer its requests 401";
      return;
    }
    conn->setRecvMsgCallback([drogonReads, tap = std::make_shared<CredentialTap>(), tapped = std::make_shared<trantor::MsgBuffer>()](
                                 const trantor::TcpConnectionPtr& conn, trantor::MsgBuffer* received) {
      const CredentialTap::Fed fed = tap->feed(std::string_view(received->peek(), received->readableBytes()));
      received->retrieveAll();
      if (!fed.forward.empty()) {
        tapped->append(fed.forward);
        drogonReads(conn, tapped.get());
      }
      if (fed.refuses) refuse(conn);
    });
  });
}

// One client connection carried to Drogon over a loopback connection of its own: the client's bytes through its tap,
// held until the loopback connection is up, and Drogon's answers back as they come. Either side closing closes the other.
class Relay : public std::enable_shared_from_this<Relay> {
public:
  Relay(const trantor::TcpConnectionPtr& client, const trantor::InetAddress& drogon)
      : client_(client), drogon_(std::make_shared<trantor::TcpClient>(client->getLoop(), drogon, "credential-tap-relay")) {}

  void start() {
    const std::weak_ptr<Relay> self = weak_from_this();
    drogon_->setConnectionCallback([self](const trantor::TcpConnectionPtr& drogon) {
      const std::shared_ptr<Relay> relay = self.lock();
      if (!relay) return;
      if (drogon->connected()) return relay->sendTapped();
      if (const trantor::TcpConnectionPtr client = relay->client_.lock()) client->shutdown();
    });
    drogon_->setConnectionErrorCallback([self] {
      const std::shared_ptr<Relay> relay = self.lock();
      if (const trantor::TcpConnectionPtr client = relay ? relay->client_.lock() : nullptr) client->forceClose();
    });
    drogon_->setMessageCallback([self](const trantor::TcpConnectionPtr&, trantor::MsgBuffer* answer) {
      const std::shared_ptr<Relay> relay = self.lock();
      if (const trantor::TcpConnectionPtr client = relay ? relay->client_.lock() : nullptr) client->send(answer->peek(), answer->readableBytes());
      answer->retrieveAll();
    });
    drogon_->connect();
  }

  void received(trantor::MsgBuffer* bytes) {
    const CredentialTap::Fed fed = tap_.feed(std::string_view(bytes->peek(), bytes->readableBytes()));
    bytes->retrieveAll();
    tapped_ += fed.forward;
    sendTapped();
    if (!fed.refuses) return;
    if (const trantor::TcpConnectionPtr client = client_.lock()) refuse(client);
  }

  void clientClosed() { drogon_->disconnect(); }

private:
  void sendTapped() {
    const trantor::TcpConnectionPtr drogon = drogon_->connection();
    if (tapped_.empty() || !drogon || !drogon->connected()) return;
    drogon->send(tapped_);
    tapped_.clear();
  }

  std::weak_ptr<trantor::TcpConnection> client_;
  std::shared_ptr<trantor::TcpClient> drogon_;
  CredentialTap tap_;
  std::string tapped_;
};

// A loopback address nothing listens on now, for Drogon behind the relay.
trantor::InetAddress freeLoopbackAddress() {
  const int probe = ::socket(AF_INET, SOCK_STREAM, 0);
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t length = sizeof address;
  const bool found = probe >= 0 && ::bind(probe, reinterpret_cast<const sockaddr*>(&address), sizeof address) == 0 &&
                     ::getsockname(probe, reinterpret_cast<sockaddr*>(&address), &length) == 0;
  if (probe >= 0) ::close(probe);
  if (!found) throw std::runtime_error("credential tap: no free loopback port for Drogon behind the relay");
  return trantor::InetAddress("127.0.0.1", ntohs(address.sin_port));
}

// Drogon listens on a loopback port, and the relay takes `host`:`port` once Drogon's listeners start.
void relayToDrogon(drogon::HttpAppFramework& app, const std::string& host, std::uint16_t port, std::size_t ioThreads) {
  const trantor::InetAddress drogon = freeLoopbackAddress();
  app.addListener(drogon.toIp(), drogon.toPort());
  // Never destroyed: it serves the port until the process ends. No SO_REUSEPORT, so a stale server on the port is a
  // failure to bind rather than a silent share.
  auto* front = new trantor::TcpServer(app.getLoop(), trantor::InetAddress(host, port), "credential-tap", true, false);
  front->setIoLoopNum(ioThreads);
  front->setConnectionCallback([drogon](const trantor::TcpConnectionPtr& client) {
    if (client->connected()) {
      const auto relay = std::make_shared<Relay>(client, drogon);
      client->setContext(relay);
      return relay->start();
    }
    if (const std::shared_ptr<Relay> relay = client->getContext<Relay>()) relay->clientClosed();
    client->clearContext();
  });
  front->setRecvMessageCallback([](const trantor::TcpConnectionPtr& client, trantor::MsgBuffer* received) {
    if (const std::shared_ptr<Relay> relay = client->getContext<Relay>()) relay->received(received);
  });
  app.registerBeginningAdvice([front] { front->start(); });
  LOG_INFO << "credential tap: relaying " << host << ":" << port << " to Drogon on " << drogon.toIpPort();
}

}

void listenTapped(drogon::HttpAppFramework& app, const std::string& host, std::uint16_t port, std::size_t ioThreads) {
  if (!kDrogonHandsOverConnections) return relayToDrogon(app, host, port, ioThreads);
  tapDrogonReaders(app);
  app.addListener(host, port);
}

}
