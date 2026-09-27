#include "platform/adapters/ws/SyncSocket.h"

#include "platform/adapters/http/Caller.h"

#include "platform/application/Heartbeat.h"
#include "platform/domain/Auth.h"
#include "platform/domain/sync/Jcs.h"

#include <trantor/utils/Logger.h>

#include <cstdint>
#include <exception>
#include <map>
#include <mutex>
#include <optional>
#include <utility>
#include <vector>

namespace wm::sync {

namespace {

// Collab's rule: a revoked session keeps reading its private scopes for at most this plus one heartbeat period.
constexpr std::uint64_t kReproveAfterMs = 60'000;
constexpr double kReproveEverySeconds = 15.0;
// RFC 6455 1013 Try Again Later: the connection's principal could not be resolved on a worker.
constexpr auto kTryAgainLater = static_cast<drogon::CloseCode>(1013);

// One connection's frames as JCS text, queued on its loop. It holds the connection weakly: the connection's
// context holds it.
class ConnectionSocket final : public LiveSocket {
public:
  explicit ConnectionSocket(const drogon::WebSocketConnectionPtr& conn) : conn_(conn) {}

  void send(const Json::Value& frame) override {
    const drogon::WebSocketConnectionPtr conn = conn_.lock();
    if (!conn || !conn->connected()) return;
    try {
      conn->send(jcs(frame));
    } catch (const std::exception& error) {
      LOG_ERROR << "sync live dropped a frame: " << error.what();
    }
  }

  void hangUp() {
    if (const drogon::WebSocketConnectionPtr conn = conn_.lock()) conn->shutdown(kTryAgainLater);
  }

private:
  std::weak_ptr<drogon::WebSocketConnection> conn_;
};

// A connection's context: its engine socket, and the strand that runs its principal, sub, unsub and close in
// arrival order.
struct LiveConnection {
  LiveConnection(WorkerPool& workers, const drogon::WebSocketConnectionPtr& conn)
      : socket(std::make_shared<ConnectionSocket>(conn)), strand(workers) {}

  std::shared_ptr<ConnectionSocket> socket;
  WorkerPool::Strand strand;
};

// Every signed-in socket's session digest and when it last proved itself. Jobs on the worker pool share it, so
// it outlives the installation for as long as one of them runs.
class Sessions {
public:
  void enter(const std::shared_ptr<LiveSocket>& socket, const std::string& digest, Ms now) {
    std::lock_guard lock(mutex_);
    sessions_.insert_or_assign(socket, Session{digest, now});
  }

  void leave(const std::shared_ptr<LiveSocket>& socket) {
    std::lock_guard lock(mutex_);
    sessions_.erase(socket);
  }

  // One pass, on a worker: each session last proven kReproveAfterMs ago or more is revalidated, and a revoked one
  // signs its socket out. The lock is never held across the session read.
  void reprove(SyncLive& live, AuthService& auth, Ms now) {
    for (const auto& [socket, digest] : due(now)) {
      const bool proven = auth.revalidate(digest).has_value();
      {
        std::lock_guard lock(mutex_);
        const auto session = sessions_.find(socket);
        if (session == sessions_.end()) continue;
        if (proven) {
          session->second.provenAt = now;
          continue;
        }
        sessions_.erase(session);
      }
      live.signOut(*socket);
    }
  }

private:
  struct Session {
    std::string digest;
    Ms provenAt = 0;
  };

  std::vector<std::pair<std::shared_ptr<LiveSocket>, std::string>> due(Ms now) {
    std::lock_guard lock(mutex_);
    std::vector<std::pair<std::shared_ptr<LiveSocket>, std::string>> due;
    for (const auto& [socket, session] : sessions_) {
      if (session.provenAt + kReproveAfterMs <= now) due.emplace_back(socket, session.digest);
    }
    return due;
  }

  std::mutex mutex_;
  std::map<std::shared_ptr<LiveSocket>, Session> sessions_;
};

// What installSyncSocket installs: the deps, the signed-in sessions, and the heartbeat that re-proves them.
struct Installed {
  explicit Installed(SyncSocketDeps deps) : deps(std::move(deps)), sessions(std::make_shared<Sessions>()), reprove("sync-live") {}

  SyncSocketDeps deps;
  std::shared_ptr<Sessions> sessions;
  Heartbeat reprove;  // last, so it destructs first, while what a pass reads is still alive
};

std::unique_ptr<Installed> g_installed;

}

void installSyncSocket(SyncSocketDeps deps) {
  g_installed = std::make_unique<Installed>(std::move(deps));
  Installed& installed = *g_installed;
  installed.reprove.start(kReproveEverySeconds, kReproveEverySeconds, [&installed] {
    installed.deps.workers->post([sessions = installed.sessions, live = installed.deps.live, auth = installed.deps.auth, clock = installed.deps.clock] {
      sessions->reprove(*live, *auth, clock->nowMs());
    });
  });
}

void linkSyncSocket() {}

void SyncSocket::handleNewConnection(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn) {
  if (!g_installed) return conn->forceClose();
  const Installed& installed = *g_installed;
  // A WebSocket upgrade gets no CORS preflight, so a stated origin must be allow-listed. A refused connection gets no
  // context, and every handler ignores a connection without one.
  const std::string origin = req->getHeader("origin");
  if (!origin.empty() && !installed.deps.allowedOrigins.contains(origin)) {
    LOG_WARN << "sync live upgrade refused: origin " << origin << " is not allow-listed";
    return conn->forceClose();
  }
  const std::string secret = sessionSecretOf(req);
  const std::string digest = secret.empty() ? "" : installed.deps.auth->digestOf(secret);

  const auto connection = std::make_shared<LiveConnection>(*installed.deps.workers, conn);
  conn->setContext(connection);
  const bool posted = connection->strand.post([live = installed.deps.live, auth = installed.deps.auth, clock = installed.deps.clock,
                                               sessions = installed.sessions, socket = connection->socket, digest] {
    std::optional<User> user;
    try {
      if (!digest.empty()) user = auth->revalidate(digest);
    } catch (...) {
      socket->hangUp();
      throw;
    }
    live->open(socket, user ? std::optional(user->id) : std::nullopt);
    if (user) sessions->enter(socket, digest, clock->nowMs());
  });
  if (!posted) conn->shutdown(kTryAgainLater);
}

void SyncSocket::handleNewMessage(const drogon::WebSocketConnectionPtr& conn, std::string&& message, const drogon::WebSocketMessageType& type) {
  const std::shared_ptr<LiveConnection> connection = conn->getContext<LiveConnection>();
  if (!g_installed || !connection || type != drogon::WebSocketMessageType::Text) return;
  // Drogon does not wrap WS callbacks, so nothing may escape: a frame that is not strict JSON is ignored.
  Json::Value frame;
  try {
    frame = parseJson(message);
  } catch (const std::exception&) {
    return;
  }
  const std::string op = frame.isObject() && frame["op"].isString() ? frame["op"].asString() : "";
  if (op == "ping") {
    Json::Value pong(Json::objectValue);
    pong["op"] = "pong";
    return connection->socket->send(pong);
  }
  // §9.5: any other op is an ephemeral product message, and none is registered. A sub the pool refuses is dropped:
  // the client subscribes again after its pull.
  if (op != "sub" && op != "unsub") return;
  connection->strand.post([live = g_installed->deps.live, socket = connection->socket, scopes = frame["scopes"], sub = op == "sub"] {
    if (sub) live->subscribe(*socket, scopes);
    else live->unsubscribe(*socket, scopes);
  });
}

void SyncSocket::handleConnectionClosed(const drogon::WebSocketConnectionPtr& conn) {
  const std::shared_ptr<LiveConnection> connection = conn->getContext<LiveConnection>();
  if (!g_installed || !connection) return;
  const auto close = [live = g_installed->deps.live, sessions = g_installed->sessions, socket = connection->socket] {
    live->close(*socket);
    sessions->leave(socket);
  };
  // The strand refuses a job only while none of its jobs is queued or running, so closing here still follows the open.
  if (!connection->strand.post(close)) close();
}

}
