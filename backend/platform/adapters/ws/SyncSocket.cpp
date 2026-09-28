#include "platform/adapters/ws/SyncSocket.h"

#include "platform/adapters/http/SyncApi.h"

#include "platform/application/Heartbeat.h"
#include "platform/domain/Auth.h"
#include "platform/domain/sync/Jcs.h"

#include <trantor/net/EventLoop.h>
#include <trantor/utils/Logger.h>

#include <exception>
#include <mutex>
#include <optional>
#include <utility>
#include <vector>

namespace wm::sync {

namespace {

constexpr double kReproveEverySeconds = 15.0;
// RFC 6455 1013 Try Again Later: the socket could not be opened on a worker.
constexpr auto kTryAgainLater = static_cast<drogon::CloseCode>(1013);
// RFC 6455 1008 Policy Violation: the socket's session stopped resolving.
constexpr auto kSessionEnded = static_cast<drogon::CloseCode>(1008);
// Where the gate leaves what it served an upgrade as, for handleNewConnection.
constexpr char kUpgradeAttribute[] = "wm.sync.upgrade";

// What the gate served an upgrade as: its principal, and the digest of every session secret it sent.
struct Upgrade {
  std::optional<UserId> principal;
  std::vector<std::string> digests;
};

// The credential the upgrade's session digests make, each proven against its session now ("" proving nothing).
Credential provenCredential(AuthService& auth, const std::vector<std::string>& digests) {
  return credentialOf(digests, [&auth](const std::string& digest) -> std::optional<UserId> {
    const std::optional<User> user = auth.revalidate(digest);
    return user ? std::optional(user->id) : std::nullopt;
  });
}

// One connection's frames as JCS text, queued on its loop until the socket closes. It holds the connection weakly:
// the connection's context holds it.
class ConnectionSocket final : public LiveSocket {
public:
  explicit ConnectionSocket(const drogon::WebSocketConnectionPtr& conn) : conn_(conn) {}

  void send(const Json::Value& frame) override {
    try {
      const std::string text = jcs(frame);
      std::lock_guard lock(mutex_);
      const drogon::WebSocketConnectionPtr conn = conn_.lock();
      if (closed_ || !conn || !conn->connected()) return;
      conn->send(text);
    } catch (const std::exception& error) {
      LOG_ERROR << "sync live dropped a frame: " << error.what();
    }
  }

  // Sends nothing more once it returns, and shuts the connection with `code`.
  void close(drogon::CloseCode code) {
    {
      std::lock_guard lock(mutex_);
      closed_ = true;
    }
    if (const drogon::WebSocketConnectionPtr conn = conn_.lock()) conn->shutdown(code);
  }

private:
  std::mutex mutex_;
  bool closed_ = false;
  std::weak_ptr<drogon::WebSocketConnection> conn_;
};

// A connection's context: its engine socket, the strand that runs its open, sub, unsub and close in arrival order,
// and its entry among the live sessions once its open made one.
struct LiveConnection {
  LiveConnection(WorkerPool& workers, const drogon::WebSocketConnectionPtr& conn)
      : socket(std::make_shared<ConnectionSocket>(conn)), strand(workers) {}

  std::shared_ptr<ConnectionSocket> socket;
  WorkerPool::Strand strand;
  std::optional<LiveSessions::Handle> session;
};

// What installSyncSocket installs: the deps, and the heartbeat that re-proves the live sessions.
struct Installed {
  explicit Installed(SyncSocketDeps deps) : deps(std::move(deps)), reprove("sync-live") {}

  SyncSocketDeps deps;
  Heartbeat reprove;  // last, so it destructs first, while what a pass reads is still alive
};

std::unique_ptr<Installed> g_installed;

drogon::HttpResponsePtr forbidden() {
  auto response = drogon::HttpResponse::newHttpResponse();
  response->setStatusCode(drogon::k403Forbidden);
  return response;
}

}

void installSyncSocket(SyncSocketDeps deps) {
  g_installed = std::make_unique<Installed>(std::move(deps));
  Installed& installed = *g_installed;
  installed.reprove.start(kReproveEverySeconds, kReproveEverySeconds, [&installed] {
    installed.deps.workers->post([sessions = installed.deps.sessions, auth = installed.deps.auth, clock = installed.deps.clock] {
      sessions->reprove([&auth](const std::string& digest) { return auth->revalidate(digest).has_value(); }, clock->nowMs());
    });
  });
}

void linkSyncSocket() {}

void SyncUpgradeGate::doFilter(const drogon::HttpRequestPtr& req, drogon::FilterCallback&& refuse, drogon::FilterChainCallback&& pass) {
  if (!g_installed) return pass();
  const SyncSocketDeps& deps = g_installed->deps;
  const std::string origin = req->getHeader("origin");
  if (!origin.empty() && !deps.allowedOrigins.contains(origin)) {
    LOG_WARN << "sync live upgrade refused: origin " << origin << " is not allow-listed";
    return refuse(forbidden());
  }
  const Json::Value envelope = SyncReply::envelope(deps.clock->nowMs(), deps.epoch);
  if (const std::optional<SyncReply> refused = schemaRefusal(req->getParameter("schema"), deps.minSchema, deps.clock->nowMs(), deps.epoch))
    return refuse(responseOf(*refused));

  std::vector<std::string> digests;
  for (const std::string& secret : sentSecretsOf(req)) digests.push_back(secret.empty() ? "" : deps.auth->digestOf(secret));
  trantor::EventLoop* loop = trantor::EventLoop::getEventLoopOfCurrentThread();
  const bool posted = deps.workers->post([auth = deps.auth, loop, req, refuse, pass, envelope, digests] {
    Upgrade upgrade{std::nullopt, digests};
    std::optional<SyncReply> refusal;
    try {
      const Credential credential = provenCredential(*auth, digests);
      if (credential.fails()) refusal = SyncReply::unauthenticated(envelope);
      else upgrade.principal = credential.servedAs();
    } catch (const std::exception& error) {
      LOG_ERROR << "sync live upgrade could not resolve its credential: " << error.what();
      refusal = SyncReply::unavailable(envelope);
    }
    loop->queueInLoop([req, refuse, pass, refusal, upgrade] {
      if (refusal) return refuse(responseOf(*refusal));
      req->attributes()->insert(kUpgradeAttribute, upgrade);
      pass();
    });
  });
  if (!posted) refuse(responseOf(SyncReply::unavailable(envelope)));
}

void SyncSocket::handleNewConnection(const drogon::HttpRequestPtr& req, const drogon::WebSocketConnectionPtr& conn) {
  // On the connection's own loop: a connection that went away while the gate resolved its credential never reports
  // its close, so it gets no context, and every handler ignores a connection without one.
  if (!g_installed || !req->attributes()->find(kUpgradeAttribute) || !conn->connected()) return conn->forceClose();
  const SyncSocketDeps& deps = g_installed->deps;
  const Upgrade upgrade = req->attributes()->get<Upgrade>(kUpgradeAttribute);
  const auto connection = std::make_shared<LiveConnection>(*deps.workers, conn);
  conn->setContext(connection);
  // The upgrade's sessions enter the registry before they are proven again, so a revocation after the gate's proof
  // closes the socket whether it lands before the proof or after it.
  const bool posted = connection->strand.post([live = deps.live, auth = deps.auth, sessions = deps.sessions, clock = deps.clock, connection, upgrade] {
    const std::shared_ptr<ConnectionSocket> socket = connection->socket;
    if (!upgrade.digests.empty()) {
      connection->session = sessions->enter(upgrade.digests, clock->nowMs(), [live, socket] {
        socket->close(kSessionEnded);
        live->close(*socket);
      });
    }
    try {
      const Credential again = provenCredential(*auth, upgrade.digests);
      if (again.fails() || again.servedAs() != upgrade.principal) return socket->close(kSessionEnded);
    } catch (...) {
      socket->close(kTryAgainLater);
      throw;
    }
    live->open(socket, upgrade.principal);
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
  const auto close = [live = g_installed->deps.live, sessions = g_installed->deps.sessions, connection] {
    live->close(*connection->socket);
    if (connection->session) sessions->leave(*connection->session);
  };
  // The strand refuses a job only while none of its jobs is queued or running, so closing here still follows the open.
  if (!connection->strand.post(close)) close();
}

}
