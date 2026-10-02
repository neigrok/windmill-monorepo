#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/adapters/postgres/PgOAuthRepository.h"
#include "platform/adapters/postgres/PgSubscriptionRepository.h"
#include "platform/adapters/postgres/PgAiUsageRepository.h"
#include "platform/application/AuthService.h"
#include "products/journal/adapters/http/JournalApi.h"
#include "products/journal/adapters/http/EchoApi.h"
#include "products/journal/adapters/http/NudgeApi.h"
#include "products/journal/adapters/postgres/PgJournalRepository.h"
#include "products/journal/adapters/postgres/PgEchoRepository.h"
#include "products/journal/adapters/postgres/PgNudgeRepository.h"

#include <drogon/drogon.h>

#include <chrono>
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>

namespace {
using namespace wm;
struct SnapshotClock : Clock {
  std::uint64_t now;
  explicit SnapshotClock(std::uint64_t value) : now(value) {}
  std::uint64_t nowMs() override { return now; }
};

class SnapshotAuth : public PgAuthRepository {
public:
  using PgAuthRepository::PgAuthRepository;
  std::optional<UserId> account;
  std::string credentialDigest;
  std::optional<StoredSession> findSession(const std::string& digest) override {
    if (!account || digest != credentialDigest) return std::nullopt;
    return StoredSession{*account, 9'007'199'254'740'991ULL};
  }
  void refreshSession(const std::string&, UnixMs, UnixMs, const std::string&,
                      const std::string&) override {}
};

struct NoEmail : EmailSender {
  void sendMagicLink(const Email&, const std::string&, std::function<void(bool)>) override {
    throw std::logic_error("snapshot attempted mail");
  }
  void sendForkLink(const Email&, const std::string&, const std::string&, const std::string&,
                    std::function<void(bool)>) override {
    throw std::logic_error("snapshot attempted mail");
  }
  void sendSignInCode(const Email&, const std::string&, std::function<void(bool)>) override {
    throw std::logic_error("snapshot attempted mail");
  }
};

struct NoFootprint : AccountFootprint {
  bool anyData(const UserId&) override { throw std::logic_error("snapshot attempted account merge"); }
};

struct NoRevocations : SessionRevocations {
  void revoked(const std::vector<std::string>&) override {
    throw std::logic_error("snapshot attempted session revocation");
  }
};

std::string filename(const std::string& value) {
  if (value.size() > 100) {
    OpenSslTokenGenerator tokens;
    return "sha256-" + tokens.digestOf(value);
  }
  constexpr char hex[] = "0123456789abcdef";
  std::string out;
  for (unsigned char c : value) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.') {
      out += c;
      continue;
    }
    out += '%';
    out += hex[c >> 4];
    out += hex[c & 15];
  }
  return out;
}

void write(const std::filesystem::path& path, std::string_view bytes) {
  std::ofstream out(path, std::ios::binary);
  out.exceptions(std::ios::failbit | std::ios::badbit);
  out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

using Params = std::map<std::string, std::string>;

struct Snapshot {
  std::filesystem::path output;
  std::string account;
  bool closedAccount = false;
  bool authenticated = true;
  bool adminAuthorized = true;
  Json::Value manifest{Json::arrayValue};
  std::set<std::string> routes;
  std::size_t count = 0;

  template <class Api, class... Ids>
  drogon::HttpResponsePtr get(Api& api,
      void (Api::*handler)(const drogon::HttpRequestPtr&, HttpCallback&&, const Ids&...),
      const std::string& pattern, const std::string& path, const Params& params,
      const Ids&... ids) {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Get);
    request->setPath(path);
    if (authenticated) request->addCookie("wm_session", "offline-journal-snapshot");
    if (adminAuthorized) request->addHeader("x-admin-token", "offline-journal-admin");
    std::string identity = "GET " + path + " authenticated=" + std::to_string(authenticated) + " admin=" + std::to_string(adminAuthorized);
    Json::Value query(Json::objectValue);
    for (const auto& [name, value] : params) {
      request->setParameter(name, value);
      identity += " " + name + "=" + value;
      query[name] = value;
    }
    std::promise<drogon::HttpResponsePtr> promise;
    auto future = promise.get_future();
    (api.*handler)(request, [&](const drogon::HttpResponsePtr& value) { promise.set_value(value); }, ids...);
    if (future.wait_for(std::chrono::seconds(30)) != std::future_status::ready) throw std::runtime_error("read door did not answer: " + path);
    const auto response = future.get();
    if ((response->getStatusCode() == drogon::k401Unauthorized && authenticated && !closedAccount) ||
        (response->getStatusCode() == drogon::k403Forbidden && adminAuthorized))
      throw std::runtime_error("snapshot owner authentication failed: " + path);
    if (response->getStatusCode() >= drogon::k500InternalServerError)
      throw std::runtime_error("read door failed: " + path);
    const auto directory = output / filename(account) / "rest";
    std::filesystem::create_directories(directory);
    const std::string name = filename(identity);
    write(directory / (name + ".body"), response->body());
    Json::Value metadata(Json::objectValue);
    metadata["status"] = static_cast<int>(response->getStatusCode());
    metadata["contentType"] = response->contentTypeString();
    metadata["headers"] = Json::Value(Json::objectValue);
    for (const auto& [header, value] : response->headers()) metadata["headers"][header] = value;
    write(directory / (name + ".json"), dump(metadata) + "\n");
    Json::Value entry(Json::objectValue);
    entry["account"] = account;
    entry["door"] = pattern;
    entry["path"] = path;
    entry["query"] = query;
    entry["authenticated"] = authenticated;
    entry["adminAuthorized"] = adminAuthorized;
    entry["file"] = (std::filesystem::path(filename(account)) / "rest" / (name + ".body")).string();
    manifest.append(entry);
    routes.insert(pattern);
    ++count;
    return response;
  }

};

struct NoEmbedder : Embedder {
  bool configured() const override { return false; }
  std::string version() const override { return "offline"; }
  std::vector<std::vector<float>> embed(const std::vector<std::string>&) override {
    throw std::logic_error("snapshot attempted embedding");
  }
};

struct NoCurator : Curator {
  bool configured() const override { return false; }
  std::string version() const override { return "offline"; }
  Curation curate(const UserId&, const std::vector<Vectored>&, const std::vector<Vectored>&,
                  const std::vector<Pairing>&) override { throw std::logic_error("snapshot attempted curation"); }
};

struct NoNudgeSender : NudgeMailSender {
  void sendJournalNudge(const Email&, const JournalNudgeMail&, std::function<void(bool)>) override {
    throw std::logic_error("snapshot attempted nudge mail");
  }
};

std::vector<std::string> strings(PgPool& pool, const std::string& query, const std::string& account) {
  PgLease connection{pool};
  pqxx::work transaction{*connection};
  std::vector<std::string> result;
  for (const auto& row : transaction.exec(query, pqxx::params{account})) result.push_back(row[0].as<std::string>());
  return result;
}

}

int main(int argc, char** argv) {
  try {
    std::filesystem::path output;
    std::string requestedAccount;
    std::uint64_t now = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
    for (int i = 1; i < argc; ++i) {
      const std::string flag = argv[i];
      if (flag == "--help") {
        std::cout << "windmill_journal_snapshot --output DIR [--account UUID] [--now-ms EPOCH_MS]\n";
        return 0;
      }
      if (i + 1 == argc) throw std::runtime_error("missing value for " + flag);
      if (flag == "--output") output = argv[++i];
      else if (flag == "--account") requestedAccount = argv[++i];
      else if (flag == "--now-ms") now = std::stoull(argv[++i]);
      else throw std::runtime_error("unknown flag: " + flag);
    }
    if (output.empty()) throw std::runtime_error("--output is required");
    if (std::filesystem::exists(output) && !std::filesystem::is_empty(output))
      throw std::runtime_error("snapshot output directory must be empty");
    const char* database = std::getenv("DATABASE_URL");
    if (!database || !*database) throw std::runtime_error("DATABASE_URL is required");
    // Compare the target engine's deterministic equal-HLC order on both sides
    // of adoption; the legacy query's physical tie order can change on UPDATE.
    if (setenv("JOURNAL_WRITE_FREEZE", "1", 1) != 0 ||
        setenv("JOURNAL_ENGINE_WRITES", "1", 1) != 0)
      throw std::runtime_error("could not select frozen journal engine read ordering");
    configureJsonReplies(drogon::app());
    auto pool = std::make_shared<PgPool>(database, 1);
    {
      PgLease connection{*pool};
      pqxx::nontransaction transaction{*connection};
      transaction.exec("SET default_transaction_read_only = on");
      transaction.exec("SET timezone = 'UTC'");
    }
    auto clock = std::make_shared<SnapshotClock>(now);
    auto tokens = std::make_shared<OpenSslTokenGenerator>();
    SnapshotAuth authRepository{pool};
    authRepository.credentialDigest = tokens->digestOf("offline-journal-snapshot");
    NoEmail email;
    NoFootprint footprint;
    NoRevocations revocations;
    PgOAuthRepository oauthRepository{pool};
    OAuthService oauth{oauthRepository, *tokens, *clock};
    const char* appUrl = std::getenv("WINDMILL_APP_URL");
    const std::string baseUrl = appUrl && *appUrl ? appUrl : "https://windmill.works";
    auto auth = std::make_shared<AuthService>(authRepository, email, *tokens, *clock, oauth,
                                            footprint, revocations, baseUrl);
    PgJournalRepository pageRepository{pool};
    auto pages = std::make_shared<PageService>(pageRepository);
    auto echoes = std::make_shared<PgEchoRepository>(pool);
    auto nudges = std::make_shared<PgNudgeRepository>(pool);
    NoNudgeSender nudgeMail;
    const char* nudgeEnabled = std::getenv("JOURNAL_NUDGE_ENABLED");
    const char* nudgeAllowlist = std::getenv("JOURNAL_NUDGE_ALLOWLIST");
    const std::string enabledFlag = nudgeEnabled ? nudgeEnabled : "";
    auto nudgeSweep = std::make_shared<NudgeSweep>(*nudges, nudgeMail, *tokens, *clock,
        MailArming(enabledFlag == "true" || enabledFlag == "1", nudgeAllowlist ? nudgeAllowlist : ""), baseUrl);
    PgSubscriptionRepository subscriptions{pool};
    PgAiUsageRepository usage{pool};
    const char* owners = std::getenv("WINDMILL_OWNER_EMAILS");
    auto entitlements = std::make_shared<Entitlements>(subscriptions, usage, owners ? owners : "");
    RuleSegmenter segmenter;
    NoEmbedder embedder;
    NoCurator curator;
    auto explainer = std::make_shared<EchoExplainer>(*echoes, segmenter, embedder, curator, *pages);
    JournalApi journal{pages, auth};
    EchoApi echo{echoes, nullptr, explainer, auth, entitlements, "offline-journal-admin"};
    NudgeApi nudge{nudges, nudgeSweep, auth, tokens, clock, "offline-journal-admin"};
    const auto accounts = strings(*pool,
        "SELECT id::text FROM users WHERE ($1 = '' OR id::text = $1) ORDER BY id::text COLLATE \"C\"", requestedAccount);
    if (!requestedAccount.empty() && accounts.empty()) throw std::runtime_error("account does not exist");
    Snapshot snapshot{output};
    std::filesystem::create_directories(output);
    for (const auto& account : accounts) {
      snapshot.account = account;
      authRepository.account = UserId{account};
      const auto owner = authRepository.findUserById(UserId{account});
      if (!owner) throw std::runtime_error("snapshot account disappeared");
      snapshot.closedAccount = owner->deletedAt.has_value();
      const auto beforeCount = snapshot.count;
      auto days = strings(*pool, "SELECT day::text FROM journal_page WHERE user_id=$1::uuid ORDER BY day", account);
      if (std::find(days.begin(), days.end(), "9999-12-31") == days.end()) days.push_back("9999-12-31");
      snapshot.get(journal, &JournalApi::listPages, "/v1/journal/pages", "/v1/journal/pages", {});
      snapshot.get(journal, &JournalApi::exportAll, "/v1/journal/export", "/v1/journal/export", {});
      snapshot.get(journal, &JournalApi::listPages, "/v1/journal/pages", "/v1/journal/pages", {{"from", "0001-01-01"}, {"to", "9999-12-31"}});
      snapshot.get(nudge, &NudgeApi::getSettings, "/v1/journal/nudge", "/v1/journal/nudge", {});
      snapshot.get(echo, &EchoApi::listEchoes, "/v1/journal/echoes", "/v1/journal/echoes", {});
      for (const auto& day : days) {
        snapshot.get(journal, &JournalApi::getPage, "/v1/journal/page/{date}", "/v1/journal/page/" + day, {}, day);
        snapshot.get(journal, &JournalApi::listPages, "/v1/journal/pages", "/v1/journal/pages", {{"from", day}, {"to", day}});
        snapshot.get(echo, &EchoApi::listEchoes, "/v1/journal/echoes", "/v1/journal/echoes", {{"from", day}, {"to", day}});
        snapshot.get(echo, &EchoApi::explainPage, "/v1/admin/journal/echo/explain/{day}", "/v1/admin/journal/echo/explain/" + day, {}, day);
      }
      auto cursors = strings(*pool, "SELECT DISTINCT (stamp_ms::text||':'||stamp_counter::text||':'||stamp_actor) COLLATE \"C\" AS cursor FROM journal_page WHERE user_id=$1::uuid ORDER BY cursor", account);
      for (const char* boundary : {"0:0:", "9007199254740991:0:snapshot"})
        if (std::find(cursors.begin(), cursors.end(), boundary) == cursors.end()) cursors.push_back(boundary);
      for (const auto& cursor : cursors) for (const char* limit : {"1", "2", "499", "500", "999", "1000", "1001", "0", "bad"})
        snapshot.get(journal, &JournalApi::listPages, "/v1/journal/pages", "/v1/journal/pages", {{"since", cursor}, {"limit", limit}});
      snapshot.authenticated = false;
      snapshot.get(journal, &JournalApi::getPage, "/v1/journal/page/{date}", "/v1/journal/page/9999-12-31", {}, std::string("9999-12-31"));
      snapshot.get(journal, &JournalApi::listPages, "/v1/journal/pages", "/v1/journal/pages", {});
      snapshot.get(journal, &JournalApi::exportAll, "/v1/journal/export", "/v1/journal/export", {});
      snapshot.get(nudge, &NudgeApi::getSettings, "/v1/journal/nudge", "/v1/journal/nudge", {});
      snapshot.get(echo, &EchoApi::listEchoes, "/v1/journal/echoes", "/v1/journal/echoes", {});
      snapshot.get(echo, &EchoApi::explainPage, "/v1/admin/journal/echo/explain/{day}", "/v1/admin/journal/echo/explain/9999-12-31", {}, std::string("9999-12-31"));
      snapshot.authenticated = true;
      snapshot.adminAuthorized = false;
      snapshot.get(echo, &EchoApi::explainPage, "/v1/admin/journal/echo/explain/{day}", "/v1/admin/journal/echo/explain/9999-12-31", {}, std::string("9999-12-31"));
      snapshot.adminAuthorized = true;
      Json::Value report(Json::objectValue);
      report["account"] = account;
      report["responses"] = Json::UInt64(snapshot.count - beforeCount);
      std::cout << dump(report) << '\n';
    }
    Json::Value inventory(Json::objectValue);
    inventory["nowMs"] = Json::UInt64(now);
    inventory["sinceOrder"] = "hlc-day";
    inventory["accounts"] = Json::UInt64(accounts.size());
    inventory["responses"] = Json::UInt64(snapshot.count);
    inventory["restGetRoutes"] = Json::Value(Json::arrayValue);
    for (const auto& route : snapshot.routes) inventory["restGetRoutes"].append(route);
    write(output / "inventory.json", dump(inventory) + "\n");
    write(output / "manifest.json", dump(snapshot.manifest) + "\n");
    std::cout << dump(inventory) << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "journal snapshot: " << error.what() << '\n';
    return 1;
  }
}
