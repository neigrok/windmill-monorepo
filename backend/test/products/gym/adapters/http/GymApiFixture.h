#pragma once

#include "products/gym/adapters/http/CatalogApi.h"
#include "products/gym/adapters/http/PreferencesApi.h"
#include "products/gym/adapters/http/ProgramApi.h"
#include "products/gym/adapters/http/ThreadsApi.h"
#include "products/gym/adapters/http/TrainingApi.h"

#include "platform/adapters/json/JsonText.h"
#include "products/gym/adapters/json/TrainingJson.h"
#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"
#include "test/testing.h"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>

// The fixture every gym HTTP test file shares — one file per adapter (TrainingApiTest,
// CatalogApiTest, ProgramApiTest, PreferencesApiTest, ThreadsApiTest), as PgGymFixture.h is for
// the Pg files. It is ONE harness holding all five adapters over ONE fake store, because a case
// about one adapter's wire routinely lays rows through another's: a movement's record is trained
// through the log's doors, a routine's proposal is read off the routines list, a units preference
// is proved by what the log reads answer. So the builders here are the request shapes and the
// bodies more than one file sends, and a helper only one file reaches for stays in that file.
//
// The fake repository enforces the SAME rules as the SQL (PK no-op, one-open refusal, max+1
// numbering), so what the wire assertions pin down is exactly what the live server says.
namespace wm::gym::apitest {

using namespace wm::fake;
using namespace wm::gym::fake;

struct Harness {
  FakeAuthRepository authRepo;
  FakeEmail email;
  FakeTokens tokens;
  FakeClock clock;
  FakeOAuthRepository oauthRepo;
  OAuthService oauth{oauthRepo, tokens, clock};
  FakeAccountFootprint footprint;
  std::shared_ptr<AuthService> auth =
      std::make_shared<AuthService>(authRepo, email, tokens, clock, oauth, footprint, "https://windmill.works");
  FakeGym repo;
  std::shared_ptr<LogService> log = std::make_shared<LogService>(
      repo.log, repo.catalog, repo.program, repo.threads, repo.preferences, clock, tokens);
  TrainingApi training{log, auth, "https://windmill.works"};
  CatalogApi catalog{log, auth};
  ProgramApi program{log, auth};
  PreferencesApi preferences{log, auth};
  ThreadsApi threads{log, auth};

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

inline Json::Value finishBody(std::uint64_t finishedAt) {
  Json::Value body(Json::objectValue);
  body["finishedAt"] = Json::Value::UInt64(finishedAt);
  return body;
}

inline drogon::HttpRequestPtr putRequest(const std::string& path, const Json::Value& body,
                                  const std::string& session = "") {
  drogon::HttpRequestPtr request = postRequest(path, body, session);
  request->setMethod(drogon::Put);
  return request;
}

inline drogon::HttpRequestPtr patchRequest(const std::string& path, const Json::Value& body,
                                    const std::string& session = "") {
  drogon::HttpRequestPtr request = postRequest(path, body, session);
  request->setMethod(drogon::Patch);
  return request;
}

inline drogon::HttpRequestPtr deleteRequest(const std::string& path, const std::string& session = "") {
  drogon::HttpRequestPtr request = getRequest(path, session);
  request->setMethod(drogon::Delete);
  return request;
}

// One line of a plan, as a client sends it: entries carry no position — the order IS the order.
inline Json::Value entryBody(const std::string& exercise = "bench-press", int targetSets = 5,
                      int targetReps = 5) {
  Json::Value entry(Json::objectValue);
  entry["exerciseId"] = exercise;
  entry["targetSets"] = targetSets;
  entry["targetReps"] = targetReps;
  entry["targetWeightKg"] = 82.5;
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

inline Json::Value renameBody(const std::string& name = "Low-bar Squat") {
  Json::Value body(Json::objectValue);
  body["name"] = name;
  return body;
}

// One handler driven as Drogon would drive it, with the reply captured. The ids after the request are
// the path segments the handler takes — none, one, or the workout-and-set pair.
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

// A whole finished workout driven through the wire, which is what the reads about a trained account
// are asked about — nothing there reaches past a handler into the store.
// bottom of this file are asked about — nothing there reaches past a handler into the store.
inline void trainedThrough(Harness& h, const std::string& cookie, const std::string& session,
                    std::uint64_t startedAt, int sets) {
  send(h.training, &TrainingApi::startSession,
       postRequest("/v1/gym/sessions", startBody(session, startedAt), cookie));
  for (int number = 1; number <= sets; ++number)
    send(h.training, &TrainingApi::appendSet,
         postRequest("/v1/gym/sessions/" + session + "/sets",
                     setBody("set_" + session.substr(4) + std::to_string(number), "bench-press",
                             82.5, startedAt + static_cast<std::uint64_t>(number) * 60'000),
                     cookie),
         session);
  send(h.training, &TrainingApi::finishSession,
       postRequest("/v1/gym/sessions/" + session + "/finish", finishBody(startedAt + 3'600'000),
                   cookie),
       session);
}

}
