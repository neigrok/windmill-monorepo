#pragma once

#include "products/gym/sync/domain/GymRules.h"
#include "products/gym/sync/ports/GymState.h"
#include "test/platform/application/sync/SyncFakes.h"

namespace wm::gym::engine::test {

class FakeGymState final : public GymState {
public:
  Json::Value load(sync::SyncTxn& txn, const sync::ScopeKey& scope) override {
    Json::Value books(Json::objectValue);
    const auto& db = sync::fake::dbOf(txn);
    books["seeds"] = db.gym["seeds"];
    for (const char* kind : {"starts", "imports", "corrections", "revisions", "bases"}) books[kind] = db.gym[kind][scope.text()];
    for (const auto& [ref, row] : db.rows) {
      if (ref.scope == scope && row.t == "routine") books["routineNames"][row.id.column()] = value(&row, "name");
    }
    return books;
  }
  void receipt(sync::SyncTxn& txn, const sync::ScopeKey& scope, const std::string& kind,
               const std::string& id, const Json::Value& receipt) override {
    sync::fake::dbOf(txn).gym[kind][scope.text()][id] = receipt;
  }
};

class FakeGymType final : public sync::fake::FakeTypeStore {
public:
  explicit FakeGymType(const sync::TypeDef& type) : FakeTypeStore(type, 0) {}
  std::set<std::string> elsewhere(sync::SyncTxn& txn, const sync::ScopeKey& scope, const std::vector<sync::RecordId>& ids) override {
    auto found = FakeTypeStore::elsewhere(txn, scope, ids);
    if (def().name == "exercise") for (const auto& id : ids) if (sync::fake::dbOf(txn).gym["seeds"].isMember(id.column())) found.insert(id.key());
    return found;
  }
  void apply(sync::SyncTxn& txn, const sync::ScopeKey& scope, const std::vector<sync::RowWrite>& writes) override {
    FakeGymState state;
    Json::Value books = state.load(txn, scope);
    for (const auto& write : writes) projectGym(books, write);
    auto& product = sync::fake::dbOf(txn).gym;
    for (const char* kind : {"revisions", "bases"}) {
      if (books[kind].isNull()) continue;
      product[kind][scope.text()] = books[kind];
      if (product[kind][scope.text()].empty()) product[kind].removeMember(scope.text());
    }
    FakeTypeStore::apply(txn, scope, writes);
  }
};

}
