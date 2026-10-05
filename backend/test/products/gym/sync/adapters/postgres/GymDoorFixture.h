#pragma once

#include "products/gym/sync/adapters/postgres/GymDoor.h"
#include "products/gym/sync/adapters/postgres/PgGymMetadataUpgrade.h"
#include "platform/infra/SyncProducts.h"
#include "products/gym/adapters/postgres/PgLogRepository.h"
#include "products/gym/adapters/postgres/PgProgramRepository.h"
#include "products/gym/adapters/postgres/PgCatalogRepository.h"
#include "products/gym/adapters/postgres/PgNotesRepository.h"
#include "products/gym/adapters/postgres/PgBodyweightRepository.h"
#include "products/gym/adapters/postgres/PgPreferencesRepository.h"
#include "test/platform/Fakes.h"

#include <pqxx/pqxx>

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

struct Harness {
  UserId user{"77777777-7777-4777-8777-777777777777"};
  UserId other{"77777777-7777-4777-8777-777777777778"};
  wm::fake::FakeClock clock;
  wm::fake::FakeTokens tokens;
  Failures failures;
  PgLogRepository log{pool()};
  PgProgramRepository program{pool()};
  PgCatalogRepository catalog{pool()};
  PgNotesRepository notes{pool()};
  PgBodyweightRepository bodyweight{pool()};
  PgPreferencesRepository preferences{pool()};
  GymDoor door{pool(), clock, failures, log, program, catalog, notes, bodyweight, preferences, sync::productCatalog()};

  Harness() {
    PgLease lease{*pool()};
    pqxx::work txn{*lease};
    txn.exec("truncate gym_sync_metadata_upgrades, gym_sync_metadata_upgrade_runs, gym_sync_adoptions, gym_ask_deleted_threads, gym_ask_threads, gym_note_saves, gym_write_receipts, gym_correction_receipts, gym_set_revisions, gym_log_shares, gym_session_shares, gym_routine_creations, gym_proposals, gym_routines, gym_sessions, gym_sets, gym_notes, gym_bodyweight, gym_preferences, gym_exercise_names, gym_exercise_aliases, sync_spent, sync_requests, sync_replicas, sync_scopes cascade");
    txn.exec("delete from gym_exercises where created_by is not null");
    txn.exec("insert into users(id,email) values($1::uuid,'gym-door@example.com'),($2::uuid,'gym-door-other@example.com') on conflict(id) do nothing", pqxx::params{user.str(), other.str()});
    txn.commit();
    engine::PgGymMetadataUpgrade(pool()).run();
  }
};

struct EngineSwitch {
  std::optional<std::string> previous;
  EngineSwitch() {
    if (const char* value = std::getenv("GYM_ENGINE_WRITES")) previous = value;
    setenv("GYM_ENGINE_WRITES", "1", 1);
  }
  ~EngineSwitch() {
    if (previous) setenv("GYM_ENGINE_WRITES", previous->c_str(), 1);
    else unsetenv("GYM_ENGINE_WRITES");
  }
};

}
