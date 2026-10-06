#pragma once

#include "products/gym/adapters/http/BodyweightApi.h"
#include "products/gym/adapters/http/CatalogApi.h"
#include "products/gym/adapters/http/NotesApi.h"
#include "products/gym/adapters/http/PreferencesApi.h"
#include "products/gym/adapters/http/ProgramApi.h"
#include "products/gym/adapters/http/ThreadsApi.h"
#include "products/gym/adapters/http/TrainingApi.h"

#include "platform/adapters/json/JsonText.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/testing.h"

#include <pqxx/pqxx>

#include <cstdint>
#include <memory>
#include <optional>
#include <vector>
#include <string>
#include <utility>

// The two harnesses every gym HTTP test file shares: the adapters over a read-only fake store, and over the real GymDoor.
namespace wm::gym::apitest {

using namespace wm::fake;
using namespace wm::gym::fake;

// The in-memory gym: rows are seeded into `repo.db` as the engine leaves them, and every write is refused.
struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works");
  FakeGym repo;
  ReadOnlyDoor door;
  std::shared_ptr<TrainingService> trainingService =
      std::make_shared<TrainingService>(repo.log, clock, tokens, door);
  std::shared_ptr<ThreadService> threadService =
      std::make_shared<ThreadService>(repo.threads, clock, door);
  TrainingApi training{trainingService, doortest::borrowed(door), auth, "https://windmill.works"};
  CatalogApi catalog{doortest::borrowed(repo.catalog), trainingService, auth};
  ProgramApi program{doortest::borrowed(repo.program), auth};
  PreferencesApi preferences{doortest::borrowed(repo.preferences), auth};
  ThreadsApi threads{threadService, auth};
  NotesApi notes{doortest::borrowed(repo.notes), auth};
  BodyweightApi bodyweight{doortest::borrowed(repo.bodyweight), auth};

  Harness() {
    repo.db.seed(benchPress());
    repo.db.seed(backSquat());
  }

  UserId signIn(const std::string& sessionSecret) {
    User user = authRepo.createUser(Email{"sam@example.com"}, "sam");
    authRepo.insertSession(tokens.digestOf(sessionSecret), user.id, clock.now + 1'000'000, "", "",
                           clock.now);
    return user.id;
  }

  // An hour's finished workout of `sets` bench sets at 82.5 × 8 a minute apart, ids `set_<session tail><n>`.
  void seedWorkout(const UserId& owner, const std::string& session, std::uint64_t startedAt, int sets) {
    repo.db.seedSession(Session{SessionId{session}, owner, startedAt, startedAt + 3'600'000, std::nullopt,
                                std::nullopt, ClosedBy::finish});
    for (int number = 1; number <= sets; ++number)
      repo.db.seedSet(Set{SetId{"set_" + session.substr(4) + std::to_string(number)}, SessionId{session},
                          ExerciseId{"bench-press"}, 0, 82.5, 8, SetKind::working, std::nullopt, "",
                          startedAt + static_cast<std::uint64_t>(number) * 60'000});
  }
};

// The gym as main.cpp builds it over the sync database, read through its adapters by a lifter signed in as `s-door`.
struct DoorApis : doortest::Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  FakeSessionRevocations revocations;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, revocations, "https://windmill.works");
  TrainingApi trainingApi{doortest::borrowed(training), doortest::borrowed(door), auth, "https://windmill.works"};
  ProgramApi programApi{doortest::borrowed(repo.program), auth};
  ThreadsApi threadsApi{doortest::borrowed(threads), auth};

  // The cookie stays good for a day of the shared clock, so a case may move it past a stale close.
  DoorApis() {
    const User account{user, Email{"gym-door@example.com"}, "Lifter", std::nullopt};
    authRepo.usersById.emplace(user.str(), account);
    authRepo.usersByEmail.emplace(account.email.value, account);
    authRepo.insertSession(tokens.digestOf("s-door"), user, clock.now + 86'400'000, "", "", clock.now);
  }

  long long seq() {
    PgLease lease{*doortest::pool()};
    pqxx::work txn{*lease};
    const auto rows = txn.exec_params("select coalesce((select seq from sync_scopes where key=$1),0)", "acct:" + user.str() + "/gym");
    return rows[0][0].as<long long>();
  }

  ToolResult call(const std::string& name, const Json::Value& args) {
    return tools.callTool(name, args, ToolCaller{user, ToolScope::everything(), ToolConnection{"cli_gymdoor", "Gym door test"}});
  }
};

inline drogon::HttpRequestPtr getRequest(const std::string& path, const std::string& session = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Get);
  request->setPath(path);
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

inline drogon::HttpRequestPtr postRequest(const std::string& path, const Json::Value& body,
                                   const std::string& session = "") {
  auto request = drogon::HttpRequest::newHttpRequest();
  request->setMethod(drogon::Post);
  request->setPath(path);
  request->setContentTypeCode(drogon::CT_APPLICATION_JSON);
  request->setBody(dump(body));
  if (!session.empty()) request->addCookie("wm_session", session);
  return request;
}

inline Json::Value startBody(const std::string& id = "ses_11111111",
                      std::uint64_t startedAt = 1'700'000'000'000) {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  body["startedAt"] = Json::Value::UInt64(startedAt);
  return body;
}

inline Json::Value setBody(const std::string& id = "set_11111111",
                    const std::string& exercise = "bench-press", double weightKg = 82.5,
                    std::uint64_t completedAt = 1'700'000'060'000) {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  body["exerciseId"] = exercise;
  body["weightKg"] = weightKg;
  body["reps"] = 8;
  body["completedAt"] = Json::Value::UInt64(completedAt);
  return body;
}

inline drogon::HttpRequestPtr deleteRequest(const std::string& path, const std::string& session = "") {
  drogon::HttpRequestPtr request = getRequest(path, session);
  request->setMethod(drogon::Delete);
  return request;
}

// A scheme as a client sends it: the wire's `sets` array, one object per set.
inline Json::Value setsBody(const std::vector<SetTarget>& sets) {
  Json::Value array(Json::arrayValue);
  for (const SetTarget& set : sets) {
    Json::Value line(Json::objectValue);
    if (set.reps) line["reps"] = *set.reps;
    if (set.weightKg) line["weightKg"] = *set.weightKg;
    array.append(line);
  }
  return array;
}

// One line of a plan, as a client sends it: entries carry no position — the order IS the order.
inline Json::Value entryBody(const std::string& exercise = "bench-press", int sets = 5,
                             int reps = 5) {
  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = exercise;
  entry["sets"] = setsBody(straight(sets, reps, 82.5));
  entry["restSeconds"] = 180;
  return entry;
}

inline Json::Value routineBody(const std::string& id = "rt_11111111", const std::string& name = "Push A") {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  body["name"] = name;
  body["position"] = 0;
  Json::Value entries(Json::arrayValue);
  entries.append(entryBody());
  body["entries"] = entries;
  return body;
}

inline Json::Value exerciseBody(const std::string& id = "ex_11111111",
                         const std::string& name = "Zercher Squat") {
  Json::Value body(Json::objectValue);
  body["id"] = id;
  body["name"] = name;
  body["pattern"] = "squat";
  body["equipment"] = "barbell";
  return body;
}

// One handler driven as Drogon would drive it, with the reply captured.
template <class Api, class... Ids, class... Given>
drogon::HttpResponsePtr send(Api& api,
                             void (Api::*handler)(const drogon::HttpRequestPtr&, HttpCallback&&,
                                                  const Ids&...),
                             const drogon::HttpRequestPtr& request, const Given&... ids) {
  drogon::HttpResponsePtr captured;
  (api.*handler)(request, [&](const drogon::HttpResponsePtr& response) { captured = response; },
                 ids...);
  return captured;
}

inline Json::Value bodyOf(const drogon::HttpResponsePtr& response) {
  return *response->getJsonObject();
}

}
