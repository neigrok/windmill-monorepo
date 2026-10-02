#include "products/gym/sync/adapters/postgres/GymDoor.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/ServerCall.h"
#include "products/gym/application/GymSwitches.h"
#include "products/gym/sync/adapters/postgres/PgGym.h"
#include "products/gym/sync/adapters/postgres/PgGymBackfill.h"
#include "products/gym/sync/GymRegistry.h"

#include <future>

namespace wm::gym {

struct GymDoor::Impl {
  std::shared_ptr<sync::SyncCatalog> catalog;
  sync::PgSyncStore store;
  sync::NullChangeFeed feed;
  sync::ServerClock stamps;
  sync::PhysicalClock now;
  sync::Admission admission;
  WorkerPool workers{"gym-sync", 4, 256};

  Impl(std::shared_ptr<PgPool> pool, Clock& clock, FailureReporter& failures, std::shared_ptr<sync::SyncCatalog> bound)
      : catalog(std::move(bound)), store(std::move(pool), sync::Limits{}.lockTimeoutMs), now(clock),
        admission(*catalog, store, feed, stamps, failures) {}
};

GymDoor::GymDoor(std::shared_ptr<PgPool> pool, Clock& clock, FailureReporter& failures,
                 LogRepository& log, ProgramRepository& program, CatalogRepository& catalog,
                 NotesRepository& notes, BodyweightRepository& bodyweight, PreferencesRepository& preferences, std::shared_ptr<sync::SyncCatalog> bound)
    : impl_(std::make_unique<Impl>(std::move(pool), clock, failures, std::move(bound))), clock_(clock), log_(log),
      program_(program), catalog_(catalog), notes_(notes), bodyweight_(bodyweight), preferences_(preferences) {}

GymDoor::~GymDoor() = default;

Json::Value GymDoor::intent() {
  Json::Value value(Json::objectValue);
  value["scope"] = "self/gym";
  value["d"] = Json::Value(Json::arrayValue);
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

Json::Value GymDoor::execute(const UserId& user, const std::string& tool, const Json::Value& args,
                             const Builder& builder, std::optional<std::string> requestId) {
  requireGymWrite();
  auto answer = std::make_shared<std::promise<Json::Value>>();
  auto future = answer->get_future();
  const bool posted = impl_->workers.post([&, answer, requestId = std::move(requestId)] {
    try {
      requireGymWrite();
      const auto build = [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
        std::optional<Json::Value> built;
        try {
          if (!engine::PgGymBackfill::adopted(txn, sync::ScopeKey::product(user, "gym")))
            throw GymUnavailable("gym-not-adopted", "gym history must be adopted before engine writes are enabled");
          built = builder(txn);
        } catch (const InvalidTraining&) {
          throw sync::ServerBuildAborted{std::current_exception()};
        } catch (const GymUnavailable&) {
          throw sync::ServerBuildAborted{std::current_exception()};
        } catch (const pqxx::undefined_column&) {
          throw sync::ServerBuildAborted{std::make_exception_ptr(GymUnavailable("gym-not-adopted", "gym adoption schema must be applied before engine writes are enabled"))};
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
      sync::ServerCall call(impl_->admission, impl_->store, user, requestId, tool, args);
      Json::Value placeholder = intent();
      placeholder["cmd"]["name"] = "gym.closeStale";
      placeholder["cmd"]["args"] = Json::Value(Json::objectValue);
      const auto now = impl_->now.nowMs();
      const auto outcome = call.admitBuilt(placeholder, now, build);
      Json::Value result;
      if (const auto* admitted = std::get_if<sync::Admitted>(&outcome)) result = admitted->result;
      if (const auto* replayed = std::get_if<sync::Replayed>(&outcome)) result = replayed->result;
      if (const auto* answered = std::get_if<sync::CallAnswered>(&outcome)) result = answered->result;
      if (result.isNull()) throw GymUnavailable("gym-engine-busy", "gym engine is temporarily unavailable");
      call.finish(result, now);
      answer->set_value(std::move(result));
    } catch (...) {
      answer->set_exception(std::current_exception());
    }
  });
  if (!posted) throw GymUnavailable("gym-engine-busy", "gym engine is temporarily unavailable");
  return future.get();
}

Json::Value GymDoor::command(const UserId& user, const std::string& name, const Json::Value& args) {
  return execute(user, name, args, [&](sync::SyncTxn&) {
    Json::Value value = intent();
    value["cmd"]["name"] = name;
    value["cmd"]["args"] = args;
    return std::optional<Json::Value>(std::move(value));
  });
}

void GymDoor::closeStale(const UserId& user) {
  if (gymWriteFrozen()) return;
  requireOk(command(user, "gym.closeStale", Json::Value(Json::objectValue)));
}

void GymDoor::unlinkThread(const UserId& user, const ThreadId& thread) {
  const auto result = execute(user, "unlink_thread", Json::Value(thread.str()), [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
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
