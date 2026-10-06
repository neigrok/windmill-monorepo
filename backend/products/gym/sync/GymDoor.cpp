#include "products/gym/sync/GymDoor.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/ServerCall.h"
#include "products/gym/sync/GymProduct.h"

#include "platform/application/WriteObservation.h"

#include <future>

namespace wm::gym {

struct GymDoor::Impl {
  std::shared_ptr<sync::SyncCatalog> catalog;
  sync::PgSyncStore store;
  sync::ServerClock stamps;
  sync::PhysicalClock now;
  sync::Admission admission;
  WorkerPool workers{"gym-sync", 4, 256};

  Impl(std::shared_ptr<PgPool> pool, Clock& clock, FailureReporter& failures,
       std::shared_ptr<sync::SyncCatalog> bound, sync::ChangeFeed& feed)
      : catalog(std::move(bound)), store(std::move(pool), sync::Limits{}.lockTimeoutMs), now(clock),
        admission(*catalog, store, feed, stamps, failures) {}
};

GymDoor::GymDoor(std::shared_ptr<PgPool> pool, Clock& clock, FailureReporter& failures,
                 LogRepository& log, ProgramRepository& program, CatalogRepository& catalog,
                 std::shared_ptr<sync::SyncCatalog> bound, sync::ChangeFeed& feed)
    : impl_(std::make_unique<Impl>(std::move(pool), clock, failures, std::move(bound), feed)), clock_(clock), log_(log),
      program_(program), catalog_(catalog) {}

GymDoor::~GymDoor() = default;

Json::Value GymDoor::intent() {
  Json::Value value(Json::objectValue);
  value["scope"] = "self/gym";
  value["d"] = Json::Value(Json::arrayValue);
  return value;
}

Json::Value GymDoor::intent(const std::string& command, const Json::Value& args) {
  Json::Value value = intent();
  value["cmd"]["name"] = command;
  value["cmd"]["args"] = args;
  return value;
}

Json::Value GymDoor::delta(const std::string& type, const std::string& id, const Json::Value& fields,
                           bool create, bool dead) {
  Json::Value value(Json::objectValue);
  value["t"] = type;
  value["id"] = id;
  const auto* def = engine::registry().type(type);
  if (def->identity == sync::Identity::minted || def->identity == sync::Identity::derived) value["born"] = Json::nullValue;
  if (create || dead) {
    value["life"] = Json::Value(Json::arrayValue);
    value["life"].append(dead ? "dead" : "alive");
    value["life"].append(Json::nullValue);
  }
  for (const auto& field : fields.getMemberNames()) {
    value["f"][field] = Json::Value(Json::arrayValue);
    value["f"][field].append(fields[field]);
    value["f"][field].append(Json::nullValue);
  }
  return value;
}

std::string GymDoor::refusal(const Json::Value& result) {
  if (result["s"] == "ok") return {};
  return result.get("code", "internal").asString();
}

void GymDoor::requireOk(const Json::Value& result) {
  const auto code = refusal(result);
  if (code.empty()) return;
  if (code == "internal") throw std::runtime_error("gym engine admission failed");
  throw GymUnavailable("gym-engine-unavailable", "gym engine refused: " + code);
}

bool GymDoor::recordTaken(sync::SyncTxn& txn, const UserId& user, const std::string& type, const std::string& id) {
  const auto scope = sync::ScopeKey::product(user, "gym");
  const auto& def = *impl_->catalog->registry().type(type);
  const std::vector<sync::RecordId> ids{sync::RecordId(id)};
  auto& store = impl_->catalog->store(type);
  if (!store.lock(txn, scope, ids).empty() || !store.elsewhere(txn, scope, ids).empty()) return true;
  return !impl_->store.spentIn(txn, scope, def, ids).empty() || !impl_->store.spentElsewhere(txn, scope, def, ids).empty();
}

Json::Value GymDoor::execute(const UserId& user, const Builder& builder) {
  auto observation = std::make_shared<WriteObservation>("gym.server_call", "gym", "server-origin");
  WriteContext context(*observation);
  auto answer = std::make_shared<std::promise<Json::Value>>();
  auto future = answer->get_future();
  const bool posted = impl_->workers.post([&, answer, observation] {
    WriteContext workerContext(*observation);
    try {
      const auto build = [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
        std::optional<Json::Value> built;
        try {
          built = builder(txn);
        } catch (const InvalidTraining&) {
          throw sync::ServerBuildAborted{std::current_exception(), "invalid"};
        } catch (const GymUnavailable& refused) {
          throw sync::ServerBuildAborted{std::current_exception(), refused.code};
        }
        if (!built) return std::nullopt;
        const sync::ScopeKey scope = sync::ScopeKey::product(user, "gym");
        for (auto& d : (*built)["d"]) {
          const auto& def = *impl_->catalog->registry().type(d["t"].asString());
          if (def.identity != sync::Identity::minted && def.identity != sync::Identity::derived) continue;
          if (d.isMember("life") && d["life"][0] == "alive") continue;
          const sync::RecordId id(d["id"]);
          auto rows = impl_->catalog->store(def.name).lock(txn, scope, {id});
          if (rows.empty()) rows = impl_->store.spentIn(txn, scope, def, {id});
          const auto row = rows.find(id.key());
          if (row != rows.end() && row->second.lattice.born) d["born"] = toString(*row->second.lattice.born);
        }
        return built;
      };
      sync::ServerCall call(impl_->admission, impl_->store, user, "gym");
      const auto now = impl_->now.nowMs();
      // Admission locks the scope this intent names, then admits what the builder builds in its place.
      const auto outcome = call.admitBuilt(intent("gym.closeStale", Json::Value(Json::objectValue)), now, build);
      // A call with no requestId is admitted or asked to retry, and a retry is the engine being busy.
      const auto* admitted = std::get_if<sync::Admitted>(&outcome);
      if (!admitted) throw GymUnavailable("gym-engine-busy", "gym engine is temporarily unavailable");
      observation->finish(impl_->catalog->observationOutcome(admitted->result));
      answer->set_value(admitted->result);
    } catch (const GymUnavailable& refused) {
      observation->finish(refused.code);
      answer->set_exception(std::current_exception());
    } catch (const InvalidTraining&) {
      observation->finish("invalid");
      answer->set_exception(std::current_exception());
    } catch (const std::exception& error) {
      observation->fail(error);
      answer->set_exception(std::current_exception());
    } catch (...) {
      observation->failUnknown();
      answer->set_exception(std::current_exception());
    }
  });
  if (!posted) {
    observation->finish("gym-engine-busy");
    throw GymUnavailable("gym-engine-busy", "gym engine is temporarily unavailable");
  }
  return future.get();
}

Json::Value GymDoor::command(const UserId& user, const std::string& name, const Json::Value& args) {
  return execute(user, [&](sync::SyncTxn&) { return std::optional<Json::Value>(intent(name, args)); });
}

void GymDoor::closeStale(const UserId& user) {
  const std::optional<Session> open = log_.open(user);
  if (!open || !isStale(*open, log_.setsOf(open->id), impl_->now.nowMs())) return;
  requireOk(command(user, "gym.closeStale", Json::Value(Json::objectValue)));
}

void GymDoor::unlinkThread(const UserId& user, const ThreadId& thread) {
  const auto result = execute(user, [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
    const auto rows = sync::sqlOf(txn).exec("select id from gym_proposals where user_id=$1::uuid and thread_id=$2 order by id", pqxx::params{user.str(), thread.str()});
    if (rows.empty()) return std::nullopt;
    auto value = intent();
    Json::Value fields(Json::objectValue);
    fields["threadId"] = Json::nullValue;
    for (const auto& row : rows) value["d"].append(delta("proposal", row[0].as<std::string>(), fields));
    return value;
  });
  requireOk(result);
}

}
