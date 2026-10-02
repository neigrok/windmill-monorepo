#pragma once

#include "products/journal/sync/domain/JournalRules.h"
#include "products/journal/sync/ports/JournalState.h"
#include "test/platform/application/sync/SyncFakes.h"

#include <limits>

namespace wm::journal::engine::test {

class FakeJournalState final : public JournalState {
public:
  Json::Value load(sync::SyncTxn& txn, const sync::ScopeKey& scope) override {
    const auto& product = sync::fake::dbOf(txn).journal;
    Json::Value books(Json::objectValue);
    books["claims"] = product["journalClaims"][scope.text()];
    books["contentClock"] = product["journalContentClocks"][scope.text()]["server"];
    return books;
  }
  void receipt(sync::SyncTxn& txn, const sync::ScopeKey& scope, const std::string& claimId,
               const Json::Value& receipt) override {
    sync::fake::dbOf(txn).journal["journalClaims"][scope.text()][claimId] = receipt;
  }
  void saveClock(sync::SyncTxn& txn, const sync::ScopeKey& scope, const Json::Value& pair) override {
    sync::fake::dbOf(txn).journal["journalContentClocks"][scope.text()]["server"] = pair;
  }
};

class FakeJournalType final : public sync::fake::FakeTypeStore {
public:
  explicit FakeJournalType(const sync::TypeDef& type) : FakeTypeStore(type, std::numeric_limits<std::size_t>::max()) {}

  void apply(sync::SyncTxn& txn, const sync::ScopeKey& scope, const std::vector<sync::RowWrite>& writes) override {
    auto& db = sync::fake::dbOf(txn);
    FakeTypeStore::apply(txn, scope, writes);
    std::set<std::string> affected;
    if (def().name != "page") return;
    for (const auto& write : writes) {
      if (write.after) db.journal["journalPages"][scope.text()][write.id.column()]["updatedAt"] = Json::UInt64(write.appliedAt.value_or(write.after->ru));
      for (const auto& revision : write.revisions) {
        const auto key = std::tuple{sync::RecordRef{scope, def().name, write.id}, revision.field, revision.rev};
        db.revisionMetadata[key] = revision.metadata;
        affected.insert(write.id.column());
      }
    }
    if (affected.empty()) return;
    std::vector<JournalRevision> revisions;
    for (const auto& [key, text] : db.revisions) {
      const auto& ref = std::get<0>(key);
      if (ref.scope != scope || ref.t != "page" || std::get<1>(key) != "body") continue;
      revisions.push_back(JournalRevision{ref.id.column(), std::get<2>(key), text.size(), db.revisionMetadata[key]["archivedAt"].asUInt64()});
    }
    std::set<Seq> kept;
    const sync::Ms now = writes.front().appliedAt.value_or(writes.front().after ? writes.front().after->ru : 0);
    for (const auto& row : pruneJournalRevisions(std::move(revisions), affected, now)) kept.insert(row.rev);
    std::erase_if(db.revisions, [&](const auto& row) {
      const auto& ref = std::get<0>(row.first);
      return ref.scope == scope && ref.t == "page" && std::get<1>(row.first) == "body" && !kept.contains(std::get<2>(row.first));
    });
    std::erase_if(db.revisionMetadata, [&](const auto& row) {
      const auto& ref = std::get<0>(row.first);
      return ref.scope == scope && ref.t == "page" && std::get<1>(row.first) == "body" && !kept.contains(std::get<2>(row.first));
    });
    if (db.journal.isMember("journalRevisionProjection") && db.journal["journalRevisionProjection"].isMember(scope.text())) {
      auto& projection = db.journal["journalRevisionProjection"][scope.text()];
      for (const auto& key : projection.getMemberNames()) if (!kept.contains(std::stoull(key))) projection.removeMember(key);
    }
  }

  void purge(sync::SyncTxn& txn, const sync::ScopeKey& scope) override {
    FakeTypeStore::purge(txn, scope);
    auto& db = sync::fake::dbOf(txn);
    std::erase_if(db.revisionMetadata, [&](const auto& row) { return std::get<0>(row.first).scope == scope && std::get<0>(row.first).t == def().name; });
    if (def().name == "page") for (const char* name : {"journalClaims", "journalContentClocks", "journalPages", "journalRevisionProjection", "journalAdoptions"}) {
      if (db.journal.isMember(name) && db.journal[name].isObject()) db.journal[name].removeMember(scope.text());
    }
  }
};

}
