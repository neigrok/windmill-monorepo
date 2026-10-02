#include "products/journal/sync/adapters/postgres/JournalDoor.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/application/WorkerPool.h"
#include "platform/application/sync/ServerCall.h"
#include "products/journal/adapters/json/PageJson.h"
#include "products/journal/application/JournalSwitches.h"
#include "products/journal/sync/adapters/json/JournalIntent.h"
#include "products/journal/sync/application/JournalFeed.h"

#include <future>
#include <algorithm>

namespace wm::journal {

namespace {

JournalUnavailable notAdopted() {
  return JournalUnavailable("journal-not-adopted",
      "journal history must be adopted before engine writes are enabled");
}

bool requireAdopted(sync::SyncTxn& txn, const UserId& user, bool beforeAdmission) {
  auto& sql = sync::sqlOf(txn);
  const auto scope = sync::ScopeKey::product(user, "journal");
  const auto rows = sql.exec(
      "select exists(select 1 from journal_sync_adoptions where user_id=$1::uuid) as marker,"
      " exists(select 1 from sync_scopes where key=$2 and state='alive') as scope,"
      " exists(select 1 from journal_page where user_id=$1::uuid and (seq is null or rc is null or ru is null"
      " or mood_stamp is null or energy_stamp is null or source_stamp is null or document_stamp_stamp is null"
      " or body_rev is null or body_merged is null)) as legacy_page,"
      " exists(select 1 from journal_page_revision where user_id=$1::uuid and engine_rev is null) as legacy_revision,"
      // Ranked state registers may be unset; row admission metadata and the
      // scope checks below distinguish them from incomplete legacy state.
      " exists(select 1 from journal_sync_state where user_id=$1::uuid and (seq is null or rc is null or ru is null)) as legacy_state,"
      " exists(select 1 from journal_page where user_id=$1::uuid)"
      " or exists(select 1 from journal_page_revision where user_id=$1::uuid)"
      " or exists(select 1 from journal_sync_state where user_id=$1::uuid) as history,"
      " exists(select 1 from journal_page_revision where user_id=$1::uuid and migration_id is not null) as frozen_revision",
      pqxx::params{user.str(), scope.text()});
  const auto& row = rows[0];
  if (row["legacy_page"].as<bool>() || row["legacy_revision"].as<bool>() || row["legacy_state"].as<bool>())
    throw notAdopted();
  if (beforeAdmission && !row["scope"].as<bool>() && (row["marker"].as<bool>() || row["history"].as<bool>()))
    throw notAdopted();
  if (!row["marker"].as<bool>() && row["frozen_revision"].as<bool>()) throw notAdopted();
  return !row["marker"].as<bool>();
}

template <typename Row>
Page pageOf(const Row& row) {
  const auto score = [&](const char* field) -> std::optional<Score> {
    if (row[field].is_null()) return std::nullopt;
    return Score::from(row[field].template as<int>());
  };
  return Page{UserId(row["user_id"].template as<std::string>()), LocalDate(row["day"].template as<std::string>()),
      row["body"].template as<std::string>(), score("mood"), score("energy"),
      parseSource(row["source"].template as<std::string>()),
      Hlc{row["stamp_ms"].template as<std::uint64_t>(), row["stamp_counter"].template as<std::uint32_t>(),
          row["stamp_actor"].template as<std::string>()}, row["updated_ms"].template as<std::uint64_t>()};
}

}

struct JournalDoor::Impl {
  std::shared_ptr<sync::SyncCatalog> catalog;
  sync::PgSyncStore store;
  sync::NullChangeFeed noFeed;
  engine::JournalFeed feed;
  sync::ServerClock stamps;
  sync::PhysicalClock now;
  sync::Admission admission;
  WorkerPool workers{"journal-sync", 4, 256};

  Impl(std::shared_ptr<PgPool> pool, Clock& clock, FailureReporter& failures, PageWatcher& watcher,
       std::shared_ptr<sync::SyncCatalog> bound, sync::ChangeFeed* next)
      : catalog(std::move(bound)), store(std::move(pool), sync::Limits{}.lockTimeoutMs), feed(watcher, next ? *next : noFeed),
        now(clock), admission(*catalog, store, feed, stamps, failures) {}
};

JournalDoor::JournalDoor(std::shared_ptr<PgPool> pool, Clock& clock, FailureReporter& failures,
                         PageWatcher& watcher, std::shared_ptr<sync::SyncCatalog> catalog, sync::ChangeFeed* next)
    : impl_(std::make_unique<Impl>(std::move(pool), clock, failures, watcher, std::move(catalog), next)) {}

JournalDoor::~JournalDoor() = default;

Json::Value JournalDoor::execute(const UserId& user, const Json::Value& intent, WriteOutcome* written) {
  requireJournalWrite();
  if (!journalEngineWrites()) throw JournalUnavailable("journal-engine-disabled", "journal engine writes are disabled");
  auto answer = std::make_shared<std::promise<Json::Value>>();
  auto future = answer->get_future();
  const bool posted = impl_->workers.post([&, answer] {
    try {
      requireJournalWrite();
      try {
        auto txn = impl_->store.begin(sync::TxnMode::snapshot);
        requireAdopted(*txn, user, true);
      } catch (const pqxx::undefined_column&) { throw notAdopted(); }
      catch (const pqxx::undefined_table&) { throw notAdopted(); }
      sync::ServerCall call(impl_->admission, impl_->store, user, std::nullopt,
          intent.isMember("cmd") ? intent["cmd"]["name"].asString() : "journalState", intent);
      const auto build = [&](sync::SyncTxn& txn) -> std::optional<Json::Value> {
        try {
          requireJournalWrite();
          if (requireAdopted(txn, user, false)) {
            const auto scope = sync::ScopeKey::product(user, "journal");
            const auto row = impl_->store.scope(txn, scope, sync::RowLock::none);
            sync::Digest256 digest;
            Seq greatest = 0;
            for (const char* type : {"page", "journalState"}) {
              for (const auto& record : impl_->catalog->store(type).feed(txn, scope, sync::FeedQuery{})) {
                digest = digest + sync::rowHash(record.toJson());
                greatest = std::max(greatest, record.seq);
              }
            }
            const auto revisions = sync::sqlOf(txn).exec("select coalesce(max(engine_rev),0) from journal_page_revision where user_id=$1::uuid", pqxx::params{user.str()});
            greatest = std::max(greatest, revisions[0][0].as<Seq>());
            if (!row || row->seq != greatest || row->digest != digest || !row->counters.empty() || row->dead || row->open)
              throw notAdopted();
          }
          if (written) {
            const auto& incoming = written->page;
            const auto rows = sync::sqlOf(txn).exec("select body,stamp_ms,stamp_counter,stamp_actor from journal_page where user_id=$1::uuid and day=$2::date",
                pqxx::params{user.str(), incoming.day.iso()});
            written->result = PageWrite::stored;
            if (!rows.empty()) {
              const Hlc stamp{rows[0][1].as<std::uint64_t>(), rows[0][2].as<std::uint32_t>(), rows[0][3].as<std::string>()};
              written->result = stamp < incoming.stamp ? PageWrite::superseded : PageWrite::ignoredStale;
            }
            auto& pg = dynamic_cast<sync::PgSyncTxn&>(txn);
            pg.beforeCommit([&, day = incoming.day] {
              const auto winner = sync::sqlOf(txn).exec(
                  "select user_id::text,day::text,body,mood,energy,source,stamp_ms,stamp_counter,stamp_actor,"
                  "(extract(epoch from updated_at)*1000)::bigint as updated_ms from journal_page where user_id=$1::uuid and day=$2::date",
                  pqxx::params{user.str(), day.iso()});
              if (!winner.empty()) written->page = pageOf(winner[0]);
            });
          }
          return intent;
        } catch (const JournalUnavailable&) { throw sync::ServerBuildAborted{std::current_exception()}; }
        catch (const pqxx::undefined_column&) { throw sync::ServerBuildAborted{std::make_exception_ptr(notAdopted())}; }
        catch (const pqxx::undefined_table&) { throw sync::ServerBuildAborted{std::make_exception_ptr(notAdopted())}; }
      };
      const auto now = impl_->now.nowMs();
      const auto outcome = call.admitBuilt(intent, now, build);
      Json::Value result;
      if (const auto* admitted = std::get_if<sync::Admitted>(&outcome)) result = admitted->result;
      if (const auto* replayed = std::get_if<sync::Replayed>(&outcome)) result = replayed->result;
      if (const auto* answered = std::get_if<sync::CallAnswered>(&outcome)) result = answered->result;
      if (result.isNull()) throw JournalUnavailable("journal-engine-busy", "journal engine is temporarily unavailable");
      call.finish(result, now);
      answer->set_value(std::move(result));
    } catch (...) { answer->set_exception(std::current_exception()); }
  });
  if (!posted) throw JournalUnavailable("journal-engine-busy", "journal engine is temporarily unavailable");
  return future.get();
}

WriteOutcome JournalDoor::savePage(const Page& incoming) {
  requireJournalWrite();
  if (incoming.body.size() > kMaxPageBytes) throw PageTooLarge("page exceeds admission limit");
  const auto intent = engine::savePageIntent(toJson(incoming), incoming.user, incoming.day);
  WriteOutcome out{incoming, PageWrite::stored};
  const auto result = execute(incoming.user, intent, &out);
  if (result["s"] == "ok") return out;
  const auto code = result.get("code", "internal").asString();
  if (code == "too-large") throw PageTooLarge("page exceeds admission limit");
  if (code == "invalid") throw InvalidPage("could not read that page");
  throw JournalUnavailable("journal-engine-unavailable", "journal engine refused: " + code);
}

Json::Value JournalDoor::claimPage(const UserId& user, const Json::Value& args) {
  requireJournalWrite();
  Json::Value intent(Json::objectValue);
  intent["scope"] = "self/journal";
  intent["d"] = Json::Value(Json::arrayValue);
  intent["cmd"]["name"] = "journal.claimPage";
  intent["cmd"]["args"] = args;
  return execute(user, intent);
}

Json::Value JournalDoor::journalState(const UserId& user, const Json::Value& fields) {
  requireJournalWrite();
  Json::Value intent(Json::objectValue);
  intent["scope"] = "self/journal";
  intent["d"] = Json::Value(Json::arrayValue);
  Json::Value delta(Json::objectValue);
  delta["t"] = "journalState";
  delta["id"] = "journalState";
  for (const auto& field : fields.getMemberNames()) {
    delta["f"][field] = Json::Value(Json::arrayValue);
    delta["f"][field].append(fields[field]);
    delta["f"][field].append(Json::nullValue);
  }
  intent["d"].append(delta);
  return execute(user, intent);
}

}
