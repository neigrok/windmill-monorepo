#include "platform/adapters/crypto/OpenSslTokenGenerator.h"
#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/adapters/postgres/PgOAuthRepository.h"
#include "platform/application/AuthService.h"
#include "products/gym/adapters/http/BodyweightApi.h"
#include "products/gym/adapters/http/CatalogApi.h"
#include "products/gym/adapters/http/NotesApi.h"
#include "products/gym/adapters/http/PreferencesApi.h"
#include "products/gym/adapters/http/ProgramApi.h"
#include "products/gym/adapters/http/ThreadsApi.h"
#include "products/gym/adapters/http/TrainingApi.h"
#include "products/gym/adapters/mcp/GymTools.h"
#include "products/gym/adapters/postgres/PgAskThreadRepository.h"
#include "products/gym/adapters/postgres/PgBodyweightRepository.h"
#include "products/gym/adapters/postgres/PgCatalogRepository.h"
#include "products/gym/adapters/postgres/PgLogRepository.h"
#include "products/gym/adapters/postgres/PgNotesRepository.h"
#include "products/gym/adapters/postgres/PgPreferencesRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"

#include <drogon/drogon.h>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>

namespace {
using namespace wm;
using namespace wm::gym;

struct SnapshotClock : Clock {
  std::uint64_t now;
  explicit SnapshotClock(std::uint64_t value) : now(value) {}
  std::uint64_t nowMs() override { return now; }
};

class FrozenLog : public PgLogRepository {
public:
  using PgLogRepository::PgLogRepository;
  void close(const SessionId&, std::uint64_t, ClosedBy) override {}
};

class SnapshotAuth : public PgAuthRepository {
public:
  using PgAuthRepository::PgAuthRepository;
  std::optional<UserId> account;
  std::string credentialDigest;
  std::optional<StoredSession> findSession(const std::string& digest) override {
    if (!account || digest != credentialDigest) return std::nullopt;
    return StoredSession{*account, kMaxInstantMs};
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
  Json::Value manifest{Json::arrayValue};
  std::set<std::string> routes;
  std::set<std::string> tools;
  std::size_t count = 0;

  template <class Api, class... Ids>
  drogon::HttpResponsePtr get(Api& api,
      void (Api::*handler)(const drogon::HttpRequestPtr&, HttpCallback&&, const Ids&...),
      const std::string& pattern, const std::string& path, const Params& params,
      const Ids&... ids) {
    auto request = drogon::HttpRequest::newHttpRequest();
    request->setMethod(drogon::Get);
    request->setPath(path);
    request->addCookie("wm_session", "offline-gym-snapshot");
    std::string identity = "GET " + path;
    Json::Value query(Json::objectValue);
    for (const auto& [name, value] : params) {
      request->setParameter(name, value);
      identity += " " + name + "=" + value;
      query[name] = value;
    }
    drogon::HttpResponsePtr response;
    (api.*handler)(request, [&](const drogon::HttpResponsePtr& value) { response = value; }, ids...);
    if (!response) throw std::runtime_error("read door did not answer: " + path);
    if ((response->getStatusCode() == drogon::k401Unauthorized && !closedAccount) ||
        response->getStatusCode() == drogon::k403Forbidden)
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
    entry["file"] = (std::filesystem::path(filename(account)) / "rest" / (name + ".body")).string();
    manifest.append(entry);
    routes.insert(pattern);
    ++count;
    return response;
  }

  ToolResult call(GymTools& host, const std::string& name, const Json::Value& arguments) {
    const ToolCaller caller{UserId{account}, parseToolScope("gym:read"), {"", ""}};
    const ToolResult result = host.callTool(name, arguments, caller);
    if (result.isError && (name == "list_exercises" || name == "list_sessions" ||
        name == "list_notes" || name == "list_bodyweight" || name == "get_stats" ||
        (name == "list_routines" && !arguments.isMember("routineId"))))
      throw std::runtime_error("valid MCP read failed: " + name + " " + dump(result.content));
    Json::Value wire(Json::objectValue);
    wire["content"] = result.content;
    wire["isError"] = result.isError;
    if (!result.structured.isNull()) wire["structuredContent"] = result.structured;
    const auto directory = output / filename(account) / "mcp";
    std::filesystem::create_directories(directory);
    const std::string file = filename(name + " " + dump(arguments)) + ".json";
    write(directory / file, dump(wire) + "\n");
    Json::Value entry(Json::objectValue);
    entry["account"] = account;
    entry["tool"] = name;
    entry["arguments"] = arguments;
    entry["file"] = (std::filesystem::path(filename(account)) / "mcp" / file).string();
    manifest.append(entry);
    tools.insert(name);
    ++count;
    return result;
  }
};

Json::Value argument(const char* field, const std::string& value) {
  Json::Value out(Json::objectValue);
  out[field] = value;
  return out;
}

std::vector<std::string> strings(PgPool& pool, const std::string& sql, const std::string& account,
                                 const std::optional<std::string>& second = std::nullopt) {
  PgLease connection{pool};
  pqxx::work transaction{*connection};
  std::vector<std::string> out;
  const auto rows = second ? transaction.exec_params(sql, account, *second)
                           : transaction.exec_params(sql, account);
  for (const auto& row : rows) out.push_back(row[0].as<std::string>());
  return out;
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
        std::cout << "windmill_gym_snapshot --output DIR [--account UUID] [--now-ms EPOCH_MS]\n";
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
    configureJsonReplies(drogon::app());
    auto pool = std::make_shared<PgPool>(database, 1);
    {
      PgLease connection{*pool};
      pqxx::nontransaction transaction{*connection};
      transaction.exec("SET default_transaction_read_only = on");
      transaction.exec("SET timezone = 'UTC'");
    }
    SnapshotClock clock{now};
    OpenSslTokenGenerator tokens;
    SnapshotAuth authRepository{pool};
    authRepository.credentialDigest = tokens.digestOf("offline-gym-snapshot");
    NoEmail email;
    NoFootprint footprint;
    NoRevocations revocations;
    PgOAuthRepository oauthRepository{pool};
    OAuthService oauth{oauthRepository, tokens, clock};
    const char* appUrl = std::getenv("WINDMILL_APP_URL");
    const std::string baseUrl = appUrl && *appUrl ? appUrl : "https://windmill.works";
    auto auth = std::make_shared<AuthService>(authRepository, email, tokens, clock, oauth,
                                           footprint, revocations, baseUrl);
    FrozenLog logRepository{pool};
    PgCatalogRepository catalogRepository{pool};
    PgProgramRepository programRepository{pool};
    PgPreferencesRepository preferencesRepository{pool};
    PgNotesRepository notesRepository{pool};
    PgBodyweightRepository bodyweightRepository{pool};
    PgAskThreadRepository threadRepository{pool};
    auto trainingService = std::make_shared<TrainingService>(logRepository, programRepository, clock, tokens);
    auto catalogService = std::make_shared<CatalogService>(catalogRepository);
    auto programService = std::make_shared<ProgramService>(programRepository, clock);
    auto preferencesService = std::make_shared<PreferencesService>(preferencesRepository);
    auto notesService = std::make_shared<NotesService>(notesRepository, clock);
    auto bodyweightService = std::make_shared<BodyweightService>(bodyweightRepository);
    auto threadService = std::make_shared<ThreadService>(threadRepository, clock);
    TrainingApi training{trainingService, auth, baseUrl};
    CatalogApi catalog{catalogService, trainingService, auth};
    ProgramApi program{programService, auth};
    PreferencesApi preferences{preferencesService, auth};
    NotesApi notes{notesService, auth};
    BodyweightApi bodyweight{bodyweightService, auth, clock};
    ThreadsApi threads{threadService, auth};
    GymTools host{*trainingService, *catalogService, *programService, *notesService, *bodyweightService, baseUrl};
    auto accounts = strings(*pool,
        "SELECT id::text FROM users WHERE ($1 = '' OR id::text = $1) ORDER BY id::text COLLATE \"C\"",
        requestedAccount);
    if (!requestedAccount.empty() && accounts.empty()) throw std::runtime_error("account does not exist");
    Snapshot snapshot{output};
    std::filesystem::create_directories(output);
    for (const std::string& account : accounts) {
      snapshot.account = account;
      authRepository.account = UserId{account};
      const auto owner = authRepository.findUserById(UserId{account});
      if (!owner) throw std::runtime_error("snapshot account disappeared");
      snapshot.closedAccount = owner->deletedAt.has_value();
      const auto beforeCount = snapshot.count;
      snapshot.get(catalog, &CatalogApi::listExercises, "/v1/gym/exercises", "/v1/gym/exercises", {});
      snapshot.get(training, &TrainingApi::lastSets, "/v1/gym/exercises/last", "/v1/gym/exercises/last", {});
      snapshot.get(training, &TrainingApi::listSessions, "/v1/gym/sessions", "/v1/gym/sessions", {});
      snapshot.get(training, &TrainingApi::history, "/v1/gym/history", "/v1/gym/history", {});
      snapshot.get(training, &TrainingApi::history, "/v1/gym/history", "/v1/gym/history", {{"projection", "progress"}, {"timeZone", "Asia/Dubai"}});
      snapshot.get(training, &TrainingApi::listLogShares, "/v1/gym/log-shares", "/v1/gym/log-shares", {});
      snapshot.get(training, &TrainingApi::stats, "/v1/gym/stats", "/v1/gym/stats", {});
      snapshot.get(program, &ProgramApi::listRoutines, "/v1/gym/routines", "/v1/gym/routines", {});
      snapshot.get(program, &ProgramApi::listProposals, "/v1/gym/proposals", "/v1/gym/proposals", {});
      snapshot.get(program, &ProgramApi::listProposals, "/v1/gym/proposals", "/v1/gym/proposals", {{"state", "pending"}});
      snapshot.get(preferences, &PreferencesApi::preferences, "/v1/gym/preferences", "/v1/gym/preferences", {});
      snapshot.get(notes, &NotesApi::listNotes, "/v1/gym/notes", "/v1/gym/notes", {});
      snapshot.get(bodyweight, &BodyweightApi::listEntries, "/v1/gym/bodyweight", "/v1/gym/bodyweight", {});
      snapshot.get(threads, &ThreadsApi::listThreads, "/v1/gym/threads", "/v1/gym/threads", {});

      auto sessionIds = strings(*pool, "SELECT id FROM gym_sessions WHERE user_id = $1::uuid ORDER BY started_at DESC, id DESC", account);
      if (sessionIds.empty()) sessionIds.push_back("ses_missing_snapshot");
      for (const auto& id : sessionIds) {
        snapshot.get(training, &TrainingApi::getSession, "/v1/gym/sessions/{id}", "/v1/gym/sessions/" + id, {}, id);
        snapshot.get(training, &TrainingApi::reviewSession, "/v1/gym/sessions/{id}/review", "/v1/gym/sessions/" + id + "/review", {}, id);
        snapshot.call(host, "get_session", argument("sessionId", id));
        auto review = argument("sessionId", id);
        review["review"] = true;
        snapshot.call(host, "get_session", review);
      }
      for (const std::string mode : {"sessions", "history", "history-progress"}) {
        const bool history = mode != "sessions";
        Params params{{"limit", "200"}};
        if (mode == "history-progress") {
          params["projection"] = "progress";
          params["timeZone"] = "Asia/Dubai";
        }
        std::set<std::string> seen;
        for (;;) {
          const auto response = history
              ? snapshot.get(training, &TrainingApi::history, "/v1/gym/history", "/v1/gym/history", params)
              : snapshot.get(training, &TrainingApi::listSessions, "/v1/gym/sessions", "/v1/gym/sessions", params);
          if (!history) {
            Json::Value args(Json::objectValue);
            args["limit"] = 200;
            if (params.count("before")) {
              args["before"] = Json::UInt64(std::stoull(params.at("before")));
              args["beforeId"] = params.at("beforeId");
            }
            snapshot.call(host, "list_sessions", args);
          }
          const auto body = response->getJsonObject();
          if (!body || !(*body)["sessions"].isArray()) break;
          const auto& rows = (*body)["sessions"];
          if (history ? !(*body)["next"].isObject() : rows.size() < 200) break;
          const auto& last = rows[rows.size() - 1];
          const std::string id = last["id"].asString();
          if (!seen.insert(id).second) throw std::runtime_error("repeated workout cursor");
          params["before"] = std::to_string(last["startedAt"].asUInt64());
          params["beforeId"] = id;
        }
      }
      auto exercises = catalogRepository.catalog(UserId{account});
      if (exercises.empty()) {
        const std::string missing = "ex_missing_snapshot";
        snapshot.get(catalog, &CatalogApi::exerciseRecord, "/v1/gym/exercises/{id}/record",
            "/v1/gym/exercises/" + missing + "/record", {}, missing);
        snapshot.get(training, &TrainingApi::lastTime, "/v1/gym/last", "/v1/gym/last", {{"exercise", missing}});
        snapshot.call(host, "last_time", argument("exerciseId", missing));
      }
      for (const auto& exercise : exercises) {
        const std::string id = exercise.id.str();
        snapshot.get(catalog, &CatalogApi::exerciseRecord, "/v1/gym/exercises/{id}/record", "/v1/gym/exercises/" + id + "/record", {}, id);
        snapshot.get(training, &TrainingApi::lastTime, "/v1/gym/last", "/v1/gym/last", {{"exercise", id}});
        snapshot.call(host, "last_time", argument("exerciseId", id));
        snapshot.call(host, "get_stats", argument("exerciseId", id));
      }
      auto routines = strings(*pool, "SELECT id FROM gym_routines WHERE user_id = $1::uuid ORDER BY id COLLATE \"C\"", account);
      if (routines.empty()) routines.push_back("rt_missing_snapshot");
      for (const auto& id : routines) {
        snapshot.get(program, &ProgramApi::getRoutine, "/v1/gym/routines/{id}", "/v1/gym/routines/" + id, {}, id);
        snapshot.call(host, "list_routines", argument("routineId", id));
      }
      auto proposals = strings(*pool, "SELECT id FROM gym_proposals WHERE user_id = $1::uuid ORDER BY id COLLATE \"C\"", account);
      if (proposals.empty()) proposals.push_back("prop_missing_snapshot");
      for (const auto& id : proposals)
        snapshot.get(program, &ProgramApi::getProposal, "/v1/gym/proposals/{id}", "/v1/gym/proposals/" + id, {}, id);

      auto threadIds = strings(*pool, "SELECT id FROM gym_ask_threads WHERE user_id = $1::uuid ORDER BY id COLLATE \"C\"", account);
      if (threadIds.empty()) threadIds.push_back("thr_missing_snapshot");
      for (const auto& id : threadIds) {
        snapshot.get(threads, &ThreadsApi::getThread, "/v1/gym/threads/{id}", "/v1/gym/threads/" + id, {}, id);
        auto attachments = strings(*pool, "SELECT id FROM gym_ask_attachments WHERE user_id = $1::uuid AND thread_id = $2 ORDER BY id COLLATE \"C\"", account, id);
        if (attachments.empty()) attachments.push_back("img_missing_snapshot");
        for (const auto& image : attachments)
          snapshot.get(threads, &ThreadsApi::getImage, "/v1/gym/threads/{thread}/attachments/{id}", "/v1/gym/threads/" + id + "/attachments/" + image, {}, id, image);
        std::uint64_t before = 0;
        std::set<std::string> seen;
        for (;;) {
          Params params{{"limit", "200"}};
          if (before) params["before"] = std::to_string(before);
          const auto response = snapshot.get(threads, &ThreadsApi::getThread, "/v1/gym/threads/{id}", "/v1/gym/threads/" + id, params, id);
          const auto body = response->getJsonObject();
          if (!body || !(*body)["nextCursor"].isString()) break;
          const auto next = (*body)["nextCursor"].asString();
          if (next.empty()) break;
          if (!seen.insert(next).second) throw std::runtime_error("repeated message cursor");
          before = std::stoull(next);
        }
      }
      std::string cursor;
      std::set<std::string> seen;
      for (;;) {
        Params params{{"limit", "200"}};
        if (!cursor.empty()) params["cursor"] = cursor;
        const auto response = snapshot.get(threads, &ThreadsApi::listThreads, "/v1/gym/threads", "/v1/gym/threads", params);
        const auto body = response->getJsonObject();
        if (!body || !(*body)["nextCursor"].isString()) break;
        cursor = (*body)["nextCursor"].asString();
        if (cursor.empty()) break;
        if (!seen.insert(cursor).second) throw std::runtime_error("repeated thread cursor");
      }
      auto shares = strings(*pool, "SELECT token FROM gym_session_shares WHERE user_id = $1::uuid ORDER BY token COLLATE \"C\"", account);
      if (shares.empty()) shares.push_back("missing-snapshot-share");
      for (const auto& token : shares)
        snapshot.get(training, &TrainingApi::sharedSession, "/v1/gym/shared/{token}", "/v1/gym/shared/" + token, {}, token);
      auto logShares = strings(*pool, "SELECT token FROM gym_log_shares WHERE user_id = $1::uuid ORDER BY token COLLATE \"C\"", account);
      if (logShares.empty()) logShares.push_back("missing-snapshot-log-share");
      for (const auto& token : logShares) {
        snapshot.get(training, &TrainingApi::sharedHistory, "/v1/gym/shared-logs/{token}", "/v1/gym/shared-logs/" + token, {}, token);
        for (bool progress : {false, true}) {
          Params params{{"limit", "200"}};
          if (progress) params["projection"] = "progress";
          std::set<std::string> seen;
          for (;;) {
            const auto response = snapshot.get(training, &TrainingApi::sharedHistory,
                "/v1/gym/shared-logs/{token}", "/v1/gym/shared-logs/" + token, params, token);
            const auto body = response->getJsonObject();
            if (!body || !(*body)["next"].isObject()) break;
            const auto& next = (*body)["next"];
            const std::string id = next["beforeId"].asString();
            if (!seen.insert(id).second) throw std::runtime_error("repeated share cursor");
            params["before"] = std::to_string(next["before"].asUInt64());
            params["beforeId"] = id;
          }
        }
      }

      for (const auto& declaration : host.declareTools()) {
        if (declaration.access != Access::read) continue;
        const std::string name = declaration.name();
        if (name == "get_session" || name == "last_time") continue;
        if (name == "get_sessions" || name == "get_last_times") {
          const auto& ids = name == "get_sessions" ? sessionIds : routines;
          std::vector<std::string> exerciseIds;
          if (name == "get_last_times") {
            for (const auto& exercise : exercises) exerciseIds.push_back(exercise.id.str());
            if (exerciseIds.empty()) exerciseIds.push_back("ex_missing_snapshot");
          }
          const auto& batch = name == "get_sessions" ? ids : exerciseIds;
          for (std::size_t start = 0; start < batch.size(); start += 50) {
            Json::Value args(Json::objectValue);
            const char* key = name == "get_sessions" ? "sessionIds" : "exerciseIds";
            args[key] = Json::Value(Json::arrayValue);
            for (std::size_t i = start; i < std::min(start + 50, batch.size()); ++i) args[key].append(batch[i]);
            if (name == "get_sessions") args["review"] = true;
            snapshot.call(host, name, args);
          }
          continue;
        }
        if (name != "list_exercises" && name != "list_sessions" && name != "list_routines" &&
            name != "get_stats" && name != "list_notes" && name != "list_bodyweight")
          throw std::runtime_error("snapshot has no request for read tool: " + name);
        snapshot.call(host, name, Json::Value(Json::objectValue));
      }
      Json::Value report(Json::objectValue);
      report["account"] = account;
      report["responses"] = Json::UInt64(snapshot.count - beforeCount);
      std::cout << dump(report) << '\n';
    }
    Json::Value inventory(Json::objectValue);
    inventory["nowMs"] = Json::UInt64(now);
    inventory["accounts"] = Json::UInt64(accounts.size());
    inventory["responses"] = Json::UInt64(snapshot.count);
    inventory["restGetRoutes"] = Json::Value(Json::arrayValue);
    inventory["mcpReadTools"] = Json::Value(Json::arrayValue);
    for (const auto& route : snapshot.routes) inventory["restGetRoutes"].append(route);
    for (const auto& tool : snapshot.tools) inventory["mcpReadTools"].append(tool);
    write(output / "inventory.json", dump(inventory) + "\n");
    write(output / "manifest.json", dump(snapshot.manifest) + "\n");
    std::cout << dump(inventory) << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "gym snapshot: " << error.what() << '\n';
    return 1;
  }
}
