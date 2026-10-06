#pragma once

#include "products/gym/sync/adapters/postgres/GymDoor.h"
#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/domain/sync/Digest.h"
#include "platform/infra/SyncProducts.h"
#include "products/gym/adapters/mcp/GymTools.h"
#include "products/gym/adapters/postgres/PgAskThreadRepository.h"
#include "products/gym/adapters/postgres/PgLogRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"
#include "products/gym/adapters/postgres/PgCatalogRepository.h"
#include "products/gym/adapters/postgres/PgNotesRepository.h"
#include "products/gym/adapters/postgres/PgBodyweightRepository.h"
#include "products/gym/adapters/postgres/PgPreferencesRepository.h"
#include "products/gym/application/CatalogService.h"
#include "products/gym/application/NotesService.h"
#include "products/gym/application/ProgramService.h"
#include "products/gym/application/ThreadService.h"
#include "products/gym/application/TrainingService.h"
#include "test/platform/Fakes.h"
#include "test/products/gym/Fakes.h"

#include <pqxx/pqxx>

#include <algorithm>
#include <fstream>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

// The gym as main.cpp builds it, over the sync database: every write a test makes here is admitted by the
// engine through the one door. Cases using it skip unless WM_PG_TEST is set (RUNNING.md §7).
namespace wm::gym::doortest {

inline std::shared_ptr<PgPool> pool() {
  static auto value = std::make_shared<PgPool>([] {
    const char* url = std::getenv("WM_SYNC_DATABASE_URL");
    if (!url) throw std::runtime_error("gym door tests require WM_SYNC_DATABASE_URL");
    return std::string(url);
  }());
  return value;
}

struct Failures : FailureReporter {
  std::vector<std::string> messages;
  void report(const std::string&, const std::string&, const std::string& detail) override { messages.push_back(detail); }
};

// The movement catalog exactly as schema.sql seeds it, re-planted for every case: the sync suite's corpus
// worlds replace the seeds on the same database.
inline const std::string& catalogSeed() {
  static const std::string statement = [] {
    std::ifstream file(WM_SCHEMA_SQL);
    const std::string schema{std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
    const std::string head = "insert into gym_exercises (id, name, pattern, equipment, step_kg) values";
    const std::string tail = "on conflict (id) do nothing;";
    const auto begin = schema.find(head);
    const auto end = begin == std::string::npos ? begin : schema.find(tail, begin);
    if (end == std::string::npos) throw std::runtime_error("schema.sql seeds no gym catalog");
    return schema.substr(begin, end + tail.size() - begin);
  }();
  return statement;
}

// The account's gym scope as the engine stored it against its rows and spent ids, recomputed: every
// admission keeps the digest the sum of the row hashes and the seq the greatest one written (§6.12).
inline bool scopeConsistent(const UserId& account) {
  const auto catalog = sync::productCatalog();
  sync::PgSyncStore store{pool(), sync::Limits{}.lockTimeoutMs};
  const auto txn = store.begin(sync::TxnMode::snapshot);
  const auto key = sync::ScopeKey::product(account, "gym");
  const auto scope = store.scope(*txn, key, sync::RowLock::none);
  if (!scope) return false;
  sync::Digest256 digest;
  Seq greatest = 0;
  for (const sync::TypeDef* type : catalog->typesIn(key.registryScope())) {
    for (const sync::Row& row : catalog->store(type->name).feed(*txn, key, sync::FeedQuery{})) {
      digest = digest + sync::rowHash(row.toJson());
      greatest = std::max(greatest, row.seq);
    }
    for (const sync::Row& row : store.feedSpent(*txn, key, *type, sync::FeedQuery{})) greatest = std::max(greatest, row.seq);
  }
  return digest == scope->digest && greatest == scope->seq;
}

// The gym's Postgres repositories, under the names FakeGym gives its in-memory ones.
struct Repositories {
  PgLogRepository log{pool()};
  PgCatalogRepository catalog{pool()};
  PgProgramRepository program{pool()};
  PgAskThreadRepository threads{pool()};
  PgPreferencesRepository preferences{pool()};
  PgNotesRepository notes{pool()};
  PgBodyweightRepository bodyweight{pool()};
};

// A shared_ptr that owns nothing, for the adapters that hold their services that way.
template <class T>
std::shared_ptr<T> borrowed(T& held) {
  return std::shared_ptr<T>(std::shared_ptr<void>{}, &held);
}

// Two accounts, an empty gym, and the services and tools over the door. The clock is the door's and the
// services' alike, so a test that moves it moves the engine's server time with it.
struct Harness {
  UserId user{"77777777-7777-4777-8777-777777777777"};
  UserId other{"77777777-7777-4777-8777-777777777778"};
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  Failures failures;
  Repositories repo;
  sync::NullChangeFeed feed;
  GymDoor door{pool(), clock, failures, repo.log, repo.program, repo.catalog, repo.notes, sync::productCatalog(), feed};
  TrainingService training{repo.log, clock, tokens, door};
  CatalogService catalog{repo.catalog, door};
  ProgramService program{repo.program, door};
  NotesService notes{repo.notes, door};
  ThreadService threads{repo.threads, clock, door};
  GymTools tools{training, catalog, program, notes, repo.bodyweight, "https://windmill.works"};

  Harness() {
    PgLease lease{*pool()};
    pqxx::work txn{*lease};
    txn.exec("truncate gym_ask_deleted_threads, gym_ask_threads, gym_note_saves, gym_write_receipts, gym_correction_receipts, gym_set_revisions, gym_log_shares, gym_session_shares, gym_routine_creations, gym_proposals, gym_routines, gym_sessions, gym_sets, gym_notes, gym_bodyweight, gym_preferences, gym_exercise_names, gym_exercise_aliases, gym_exercises, sync_spent, sync_requests, sync_replicas, sync_scopes cascade");
    txn.exec(catalogSeed());
    txn.exec("insert into users(id,email) values($1::uuid,'gym-door@example.com'),($2::uuid,'gym-door-other@example.com') on conflict(id) do nothing", pqxx::params{user.str(), other.str()});
    txn.commit();
  }

  // A write a phone makes through /v1/sync, admitted as the server's own intent: the deltas in, the result
  // out. GymDoor::delta builds one.
  Json::Value admit(const UserId& account, const std::vector<Json::Value>& deltas) {
    return door.execute(account, "test_admit", Json::Value(Json::objectValue), [&](sync::SyncTxn&) {
      Json::Value intent = GymDoor::intent();
      for (const Json::Value& delta : deltas) intent["d"].append(delta);
      return std::optional<Json::Value>{intent};
    });
  }

  // A record a phone deleted: its death delta, admitted.
  void kill(const UserId& account, const std::string& type, const std::string& id) {
    GymDoor::requireOk(admit(account, {GymDoor::delta(type, id, Json::Value(Json::objectValue), false, true)}));
  }
};

}
