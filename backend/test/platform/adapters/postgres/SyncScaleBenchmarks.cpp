#include "platform/adapters/clock/SystemClock.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/SyncService.h"
#include "test/platform/adapters/postgres/PgSyncWorld.h"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>

#ifndef __OPTIMIZE__
#error "Scale measurements require an optimized build"
#endif

using namespace wm::sync;

namespace {

void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

Json::Value read(const std::filesystem::path& path) {
  std::ifstream stream(path);
  require(stream.good(), "fixture file could not be opened");
  Json::Value value;
  stream >> value;
  return value;
}

Json::Value object(std::initializer_list<std::pair<const char*, Json::Value>> members) {
  Json::Value value(Json::objectValue);
  for (const auto& [name, item] : members) value[name] = item;
  return value;
}

double ms(std::chrono::steady_clock::time_point start) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
}

}

int main(int argc, char** argv) {
  try {
    require(argc == 3, "usage: windmill_sync_scale FIXTURE_DIRECTORY REPORT_JSONL");
    require(std::getenv("WM_PG_TEST") && std::getenv("WM_SCALE_DATABASE_URL") && std::getenv("WM_SCALE_ALLOW_RESET"),
            "set WM_PG_TEST, WM_SCALE_DATABASE_URL and WM_SCALE_ALLOW_RESET=1 for an isolated scale database");
    require(std::string(std::getenv("WM_SCALE_ALLOW_RESET")) == "1", "database reset must be explicitly enabled");
    wm::BlockingThread::Mark blocking;
    test::PgWorld world;
    std::string postgresVersion;
    {
      auto transaction = world.store().begin(TxnMode::snapshot);
      const auto name = wm::sync::sqlOf(*transaction).exec("select current_database()")[0][0].as<std::string>();
      require(name.find("_scale_") != std::string::npos, "benchmark database name must contain _scale_");
      postgresVersion = wm::sync::sqlOf(*transaction).exec("show server_version")[0][0].as<std::string>();
    }
    const std::filesystem::path directory(argv[1]);
    const auto manifest = read(directory / "manifest.json");
    const auto pending = read(directory / "pending-entries.json");
    std::ofstream report(argv[2], std::ios::app);
    require(report.good(), "report could not be opened");
    for (const auto& scenario : manifest["scenarios"].getMemberNames()) {
      if (const char* selected = std::getenv("SYNC_ROADMAP_SCALE_SCENARIO"); selected && scenario != selected) continue;
      const auto fixture = read(directory / (scenario + ".json"));
      world.seed(fixture);
      world.failures.reports.clear();
      world.feed.published.clear();
      wm::SystemClock clock;
      Admission admission(world.catalog(), world.store(), world.feed, world.clock(), world.failures);
      SyncService service(world.catalog(), world.store(), admission, clock);
      const auto credential = Credential::sent(world.account("A"));
      Json::Value result = object({{"scenario", scenario}, {"storage", "Postgres"},
        {"transport", "SyncService calls; HTTP/TLS and client storage excluded"},
        {"sourceHead", std::getenv("SYNC_BENCH_SOURCE_HEAD") ? std::getenv("SYNC_BENCH_SOURCE_HEAD") : "unspecified"},
        {"compiler", __VERSION__}, {"buildType", WM_SCALE_BUILD_TYPE}, {"postgresVersion", postgresVersion},
        {"cache", "freshly seeded database; Postgres and OS pages may be warm"}, {"requests", Json::Value(Json::arrayValue)}});
#ifdef NDEBUG
      result["assertions"] = "disabled";
#else
      result["assertions"] = "enabled";
#endif
      const auto helloStart = std::chrono::steady_clock::now();
      const auto hello = service.hello(credential);
      result["helloMs"] = ms(helloStart);
      require(hello.status == 200, "hello failed");
      std::map<std::string, Json::Value> cursors{{"self/probe", Json::nullValue}};
      if (scenario != "pending") for (const auto& row : fixture["rows"]["acct:A/probe"]) {
        require(row["t"] == "board", "unexpected governing record type");
        cursors.emplace("tree/" + row["id"].asString(), Json::nullValue);
        cursors.emplace("self/overlay/" + row["id"].asString(), Json::nullValue);
      }
      std::set<std::string> complete;
      std::size_t received = 0;
      double requestTotal = 0;
      for (int round = 0; complete.size() < cursors.size(); ++round) {
        require(round < 2'000, "pull did not finish");
        Json::Value scopes(Json::arrayValue);
        for (const auto& [scope, cursor] : cursors) {
          if (complete.contains(scope)) continue;
          scopes.append(object({{"scope", scope}, {"cursor", cursor}}));
          if (scopes.size() == Limits{}.pullMaxScopes) break;
        }
        const auto body = jcs(object({{"scopes", scopes}}));
        const auto started = std::chrono::steady_clock::now();
        const auto reply = service.pull(credential, body);
        const double elapsed = ms(started);
        requestTotal += elapsed;
        require(reply.status == 200, "pull failed");
        std::size_t rows = 0;
        for (const auto& page : reply.body["pages"]) {
          require(page["kind"] == "rows", "pull returned a non-row page");
          const auto scope = page["scope"].asString();
          cursors.at(scope) = page["cursor"];
          rows += page["rows"].size();
          if (!page["more"].asBool()) complete.insert(scope);
        }
        received += rows;
        result["requests"].append(object({{"endpoint", "pull"}, {"ms", elapsed}, {"scopes", scopes.size()}, {"rows", Json::UInt64(rows)}}));
      }
      const std::size_t expected = manifest["scenarios"][scenario]["serverRecords"].asUInt64();
      require(received == expected, "pull record count differs from common fixture");
      require(complete.size() == (scenario == "pending" ? 1 : manifest["scenarios"][scenario]["followedScopes"].asUInt64()),
              "pull scope count differs from common fixture");
      result["pullMs"] = requestTotal;
      result["pulledRows"] = Json::UInt64(received);
      result["pulledScopes"] = Json::UInt64(complete.size());
      result["pullCoverage"] = scenario == "pending" ? "empty account product before queued governing create" : "all seeded product, tree and overlay scopes";

      Json::Value intents(Json::arrayValue);
      if (scenario == "pending") {
        for (Json::ArrayIndex i = 0; i < 2; ++i) {
          auto intent = pending[i]["intent"];
          intent["n"] = i + 1;
          intents.append(intent);
        }
      } else {
        Json::Value born;
        const std::string treeKey = "tree:" + manifest["tree"].asString().substr(5);
        for (const auto& row : fixture["rows"][treeKey]) {
          if (row["t"] == "tag" && row["id"] == "step0") born = row["born"];
        }
        require(!born.isNull(), "measured tag has no seeded incarnation");
        Json::Value label(Json::arrayValue);
        label.append("Edited"); label.append(std::to_string(clock.nowMs()) + ":0:r_aaaaaaaaaaaa");
        Json::Value deltas(Json::arrayValue);
        deltas.append(object({{"t", "tag"}, {"id", "step0"}, {"born", born}, {"f", object({{"label", label}})}}));
        intents.append(object({{"n", 1}, {"scope", manifest["tree"]}, {"d", deltas}, {"gestureId", "scale-edit"}}));
      }
      double pushTotal = 0;
      for (const auto& intent : intents) {
        Json::Value batch(Json::arrayValue);
        batch.append(intent);
        const auto request = object({{"replica", "rp_0000000000000000000000000000000a"},
          {"account", world.account("A").str()}, {"ackThrough", intent["n"].asUInt64() - 1}, {"intents", batch}});
        const auto body = jcs(request);
        TimeBudget budget(Limits{}.pushWorkMs);
        const auto started = std::chrono::steady_clock::now();
        const auto reply = service.push(credential, body, budget);
        const double elapsed = ms(started);
        pushTotal += elapsed;
        require(reply.status == 200 && reply.body["results"].size() == 1, "push did not admit the measured intent");
        require(reply.body["results"][0]["s"] == "ok", "measured gesture was refused");
        result["requests"].append(object({{"endpoint", "push"}, {"ms", elapsed}, {"intents", 1}}));
      }
      result["pushMs"] = pushTotal;
      require(world.failures.reports.empty(), "engine reported a technical failure");
      result["pushIntents"] = intents.size();
      result["pushCoverage"] = scenario == "pending" ? "queued governing create and first three-row tree intent; remaining queue not uploaded" : "one tag update in the seeded tree";
      const auto line = jcs(result);
      report << line << '\n'; report.flush();
      std::cout << line << '\n';
    }
    return 0;
  } catch (const std::exception& failure) {
    std::cerr << "scale benchmark failed: " << failure.what() << '\n';
    return 1;
  }
}
